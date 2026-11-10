import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { LedgerDatabase } from "./transaction-hash.js";
import { VoiceConnectionError } from "./voice-realtime.js";

/** Owner decision 2026-10-19: GPT-Live ($0.05/min) at the voice rate of 1,200 credits per
 * dollar, charged per started minute, at most 15 minutes a call. */
export const LIVE_CREDITS_PER_MINUTE = 60;
export const LIVE_MAX_MINUTES = 15;
/** The browser beats every 30 s; two missed beats and a margin mean the tab is gone. */
export const LIVE_HEARTBEAT_STALE_MS = 75_000;
export const LIVE_SWEEP_MS = 15_000;
/** Charge the next minute this long before it starts, so a slow sweep never gives one away. */
const CHARGE_AHEAD_MS = 10_000;
const CONNECT_ABANDON_MS = 120_000;
const CLAIM_MS = 30_000;

export function liveCreditsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VOICE_LIVE_CREDITS_ENABLED === "true" && Boolean(env.OPENAI_API_KEY?.trim());
}
export function liveCreditsKey(env: Record<string, string | undefined> = process.env): string | null {
  return liveCreditsEnabled(env) ? env.OPENAI_API_KEY!.trim() : null;
}

export interface LiveCreditDeps {
  db: LedgerDatabase;
  /** Idempotent by referenceId; throws Error("INSUFFICIENT_CREDITS") when the wallet cannot pay. */
  deduct(userId: string, credits: number, referenceId: string, description: string): Promise<unknown>;
  available(userId: string): Promise<number>;
  /** The session plays the world this pricing is for. */
  isWorld(sessionId: string): Promise<boolean>;
  /** Hang up the provider call (404 counts as done). Throws when unconfirmed. */
  hangup(providerId: string): Promise<void>;
  /** Release this instance's in-memory call and lease, when it owns one. */
  stopLocal?(userId: string, sessionId: string): Promise<void>;
  enabled?(): boolean;
  now?(): number;
}

export interface LiveCreditConfig {
  available: boolean;
  funding: "credits-live";
  creditsPerMinute: number;
  maxDurationSeconds: number;
  code?: "VOICE_CREDITS_REQUIRED";
}

interface Row {
  id: string; user_id: string; session_id: string; provider_id: string | null; state: string;
  started_at: Date | string | null; last_heartbeat_at: Date | string | null; created_at: Date | string;
  paid_minutes: number; credits_per_minute: number; max_minutes: number;
}
const rowsOf = <T>(result: unknown): T[] => Array.isArray(result) ? result as T[] : ((result as { rows?: T[] }).rows ?? []);
const ms = (value: Date | string | null) => value === null ? null : new Date(value).getTime();
const insufficient = (error: unknown) => error instanceof Error && error.message === "INSUFFICIENT_CREDITS";

/** Wall-clock billing for credits-paid GPT-Live calls. All state lives in voice_live_calls, so a
 * deploy or restart never leaves a paid call running: any instance's sweep finds it. */
export class LiveCreditCalls {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  constructor(private deps: LiveCreditDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private at(offsetMs = 0) { return new Date(this.now() + offsetMs).toISOString(); }

  /** Null: this session is not priced this way. Otherwise the config the client shows. */
  async config(userId: string, sessionId: string): Promise<LiveCreditConfig | null> {
    if (!(this.deps.enabled?.() ?? true) || !await this.deps.isWorld(sessionId)) return null;
    const enough = await this.deps.available(userId) >= LIVE_CREDITS_PER_MINUTE;
    return { available: enough, funding: "credits-live", creditsPerMinute: LIVE_CREDITS_PER_MINUTE,
      maxDurationSeconds: LIVE_MAX_MINUTES * 60, ...(enough ? {} : { code: "VOICE_CREDITS_REQUIRED" as const }) };
  }

  /** Reserve the account's one open call before any provider call exists. */
  async begin(userId: string, sessionId: string, connectionId?: string): Promise<string> {
    if (await this.deps.available(userId) < LIVE_CREDITS_PER_MINUTE) throw new VoiceConnectionError("VOICE_CREDITS_REQUIRED");
    // A new call always wins: the account's older call (stuck, abandoned, or another tab) is closed
    // here, so its billing stops and nothing ever refuses the player. Owner, 2026-10-22: a stale
    // "closing" row blocked every new call with 429 ("the line could not open").
    const older = rowsOf<Row>(await this.deps.db.execute(sql`UPDATE voice_live_calls
      SET state = 'closed', closed_at = ${this.at()}, claimed_until = NULL, close_reason = COALESCE(close_reason, 'replaced')
      WHERE user_id = ${userId} AND state <> 'closed' RETURNING *`));
    for (const row of older) if (row.provider_id) void this.deps.hangup(row.provider_id).catch(() => {});
    const id = randomUUID();
    try {
      await this.deps.db.execute(sql`INSERT INTO voice_live_calls (id, user_id, session_id, connection_id, credits_per_minute, max_minutes, created_at)
        VALUES (${id}, ${userId}, ${sessionId}, ${connectionId ?? null}, ${LIVE_CREDITS_PER_MINUTE}, ${LIVE_MAX_MINUTES}, ${this.at()})`);
    } catch { throw new VoiceConnectionError("VOICE_CONNECTION_PENDING"); }
    return id;
  }

  /** The provider call exists: record it and take the first minute. False hangs it up. */
  async activate(id: string, providerId: string): Promise<boolean> {
    const rows = rowsOf<Row>(await this.deps.db.execute(sql`UPDATE voice_live_calls
      SET provider_id = ${providerId}, state = 'active', started_at = ${this.at()}, last_heartbeat_at = ${this.at()}
      WHERE id = ${id} AND state = 'connecting' RETURNING *`));
    const row = rows[0];
    if (!row) return false;
    if (await this.charge(row, 1)) return true;
    await this.markClosing(id, "balance");
    return false;
  }

  /** Negotiation failed. A call the provider created is hung up by the sweep. */
  async abandon(id: string): Promise<void> {
    await this.deps.db.execute(sql`UPDATE voice_live_calls SET state = 'closed', close_reason = 'failed', closed_at = ${this.at()}
      WHERE id = ${id} AND state = 'connecting'`);
    await this.deps.db.execute(sql`UPDATE voice_live_calls SET state = 'closing', close_reason = COALESCE(close_reason, 'failed')
      WHERE id = ${id} AND state = 'active'`);
  }

  async heartbeat(userId: string, sessionId: string): Promise<boolean> {
    const rows = rowsOf<Row>(await this.deps.db.execute(sql`UPDATE voice_live_calls SET last_heartbeat_at = ${this.at()}
      WHERE user_id = ${userId} AND session_id = ${sessionId} AND state = 'active' RETURNING id`));
    return rows.length > 0;
  }

  async stop(userId: string, sessionId: string): Promise<void> {
    const rows = rowsOf<Row>(await this.deps.db.execute(sql`UPDATE voice_live_calls SET state = 'closing', close_reason = COALESCE(close_reason, 'stopped'), claimed_until = NULL
      WHERE user_id = ${userId} AND session_id = ${sessionId} AND state IN ('connecting', 'active') RETURNING *`));
    for (const row of rows) await this.finish(row);
  }

  private async charge(row: Row, minute: number): Promise<boolean> {
    try {
      await this.deps.deduct(row.user_id, row.credits_per_minute, `voice-live:${row.id}:${minute}`, `Live voice, minute ${minute}`);
    } catch (error) {
      if (insufficient(error)) return false;
      throw error;
    }
    // Two sweeps can charge the same minute; the reference makes the second a no-op,
    // and only one of them advances the count.
    await this.deps.db.execute(sql`UPDATE voice_live_calls SET paid_minutes = ${minute}
      WHERE id = ${row.id} AND paid_minutes = ${minute - 1}`);
    return true;
  }

  private async markClosing(id: string, reason: string): Promise<void> {
    await this.deps.db.execute(sql`UPDATE voice_live_calls SET state = 'closing', close_reason = COALESCE(close_reason, ${reason})
      WHERE id = ${id} AND state IN ('connecting', 'active')`);
  }

  /** Hang up outside any transaction; an unconfirmed hangup stays 'closing' for the next sweep. */
  private async finish(row: Row): Promise<void> {
    await this.deps.stopLocal?.(row.user_id, row.session_id).catch(() => {});
    // Best effort: OpenAI's live hangup answered 503 even for long-ended sessions. The call is over
    // for billing either way (the browser's connection ending ends the session), so it closes now.
    if (row.provider_id) await this.deps.hangup(row.provider_id).catch(() => {});
    await this.deps.db.execute(sql`UPDATE voice_live_calls SET state = 'closed', closed_at = ${this.at()}, claimed_until = NULL,
      close_reason = COALESCE(close_reason, 'stopped') WHERE id = ${row.id} AND state <> 'closed'`);
  }

  /** One pass: claim open rows (SKIP LOCKED, one short statement), then act on each outside it. */
  sweep(): Promise<void> {
    this.sweeping ??= this.sweepOnce().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }
  private async sweepOnce(): Promise<void> {
    const claimed = rowsOf<Row>(await this.deps.db.execute(sql`UPDATE voice_live_calls SET claimed_until = ${this.at(CLAIM_MS)}
      WHERE id IN (SELECT id FROM voice_live_calls WHERE state <> 'closed' AND (claimed_until IS NULL OR claimed_until < ${this.at()})
        ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING *`));
    const now = this.now();
    for (const row of claimed) {
      try {
        if (row.state === "closing") { await this.finish(row); continue; } // a failed hangup waits out its claim
        if (row.state === "connecting") {
          if (now - ms(row.created_at)! > CONNECT_ABANDON_MS) {
            await this.deps.db.execute(sql`UPDATE voice_live_calls SET state = 'closed', close_reason = 'failed', closed_at = ${this.at()}, claimed_until = NULL
              WHERE id = ${row.id} AND state = 'connecting'`);
          }
          continue;
        }
        const started = ms(row.started_at)!, elapsed = now - started;
        const reason = elapsed >= row.max_minutes * 60_000 ? "cap"
          : now - (ms(row.last_heartbeat_at) ?? started) > LIVE_HEARTBEAT_STALE_MS ? "abandoned" : null;
        if (reason) { await this.markClosing(row.id, reason); await this.finish({ ...row, state: "closing" }); continue; }
        if (row.paid_minutes < row.max_minutes && elapsed >= row.paid_minutes * 60_000 - CHARGE_AHEAD_MS
          && !await this.charge(row, row.paid_minutes + 1)) {
          await this.markClosing(row.id, "balance"); await this.finish({ ...row, state: "closing" });
        }
        // Done with this row for this pass: the next sweep (any instance) may take it at once.
        await this.deps.db.execute(sql`UPDATE voice_live_calls SET claimed_until = NULL WHERE id = ${row.id} AND state <> 'closed'`);
      } catch { /* Left claimed; the claim expires and the next sweep retries. */ }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, LIVE_SWEEP_MS);
    this.timer.unref?.();
  }
  stopSweep(): void { clearInterval(this.timer); this.timer = undefined; }
}
