import { createHash, randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, worldPendingEdits, worlds } from "../db/schema.js";
import type { ChatMessage, StreamChunk, ToolCall } from "./llm/types.js";
import type { ToolResult } from "./studio-tools/index.js";

export type StudioCreditTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface StudioCreditScope { runId: string; worldId: string; userId: string }
export interface StudioCreditWorldScope { worldId: string; userId: string }

export interface StudioGeneratedCreditResult {
  textContent: string;
  reasoningContent?: string;
  toolCalls: ToolCall[];
  usage?: StreamChunk["usage"];
  cost: number;
  /** Reuse this reference when settling a resumed result; never mint a new one. */
  usageLogId: string;
  stopReason?: string;
  /** A zero cost here is a sentinel, not permission to deliver free work. */
  billingUnavailable?: boolean;
  /** The ledger settled this result; retrying its tools needs no new credit. */
  settled?: boolean;
  /** Written atomically with each applied mutation; replay skips these keys. */
  progress?: Record<string, ToolResult>;
}

interface CheckpointBase {
  version: 1;
  messages: ChatMessage[];
  iteration: number;
  worldRevision: string;
  requiredCredits: number;
  /** Durable diagnostic; public APIs map private errors to a safe category. */
  reason?: string;
  claim?: { id: string; claimedAt: string };
}

export type StudioCreditCheckpoint = CheckpointBase & (
  | { phase: "preflight"; generated?: never }
  | { phase: "generated"; generated: StudioGeneratedCreditResult }
);

export type StudioCreditResumeFailureCode =
  | "NOT_FOUND" | "NOT_PAUSED" | "ACTIVE_RUN" | "STALE_WORLD" | "INVALID_CHECKPOINT" | "CLAIM_LOST";

/** Longer than the live worker heartbeat; both timestamps must be this old. */
export const STUDIO_CREDIT_CLAIM_STALE_MS = 5 * 60 * 1000;

/** Shared by status presentation and the locked claim operation. This is only
 * worker eligibility; ownership and the source world revision still need to be
 * checked under the transaction lock before replaying anything. */
export function isStudioCreditResumeEligible(
  run: Pick<typeof agentRuns.$inferSelect, "status" | "error" | "updatedAt">,
  checkpoint: StudioCreditCheckpoint | null,
  now = Date.now(),
): boolean {
  if (run.status === "awaiting_credits") return true;
  const claimTime = checkpoint?.claim ? Date.parse(checkpoint.claim.claimedAt) : NaN;
  return (run.status === "running" || run.status === "error")
    && !/stopped by user|superseded/i.test(run.error ?? "")
    && Number.isFinite(claimTime) && now - claimTime >= STUDIO_CREDIT_CLAIM_STALE_MS
    && !!run.updatedAt && now - run.updatedAt.getTime() >= STUDIO_CREDIT_CLAIM_STALE_MS;
}

export class StudioCreditCheckpointError extends Error {
  constructor(readonly code: StudioCreditResumeFailureCode) {
    super(code);
    this.name = "StudioCreditCheckpointError";
  }
}

// JSONB can reorder object keys. A canonical digest includes content as well as
// timestamps, so same-millisecond writes and held-edit changes remain visible.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Lock order is always world -> run. New-run creation must use the world lock too. */
async function lockedWorld(tx: StudioCreditTransaction, scope: StudioCreditWorldScope) {
  const [world] = await tx.select({
    id: worlds.id, status: worlds.status, schema: worlds.schema, updatedAt: worlds.updatedAt,
  }).from(worlds).where(and(eq(worlds.id, scope.worldId), eq(worlds.creatorId, scope.userId))).for("update");
  if (!world) return null;
  return world;
}

async function worldState(tx: StudioCreditTransaction, world: NonNullable<Awaited<ReturnType<typeof lockedWorld>>>) {
  const [pending] = world.status === "published"
    ? await tx.select({ id: worldPendingEdits.id, schema: worldPendingEdits.schema, updatedAt: worldPendingEdits.updatedAt })
      .from(worldPendingEdits).where(eq(worldPendingEdits.worldId, world.id)).for("update")
    : [];
  const schema = (pending?.schema ?? world.schema) as Record<string, unknown>;
  const revision = createHash("sha256").update(canonicalJson({
    status: world.status,
    updatedAt: world.updatedAt?.toISOString() ?? null,
    pendingId: pending?.id ?? null,
    pendingUpdatedAt: pending?.updatedAt?.toISOString() ?? null,
    schema,
  })).digest("hex");
  return { revision, schema };
}

export async function captureStudioCreditWorldRevision(scope: StudioCreditWorldScope) {
  return db.transaction(async tx => {
    const world = await lockedWorld(tx, scope);
    if (!world) throw new StudioCreditCheckpointError("NOT_FOUND");
    return worldState(tx, world);
  });
}

function scopedRun(scope: StudioCreditScope) {
  return and(eq(agentRuns.id, scope.runId), eq(agentRuns.worldId, scope.worldId), eq(agentRuns.userId, scope.userId));
}

/** Reject incomplete persisted payloads before claiming or charging anything. */
export function readStudioCreditCheckpoint(value: unknown): StudioCreditCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<StudioCreditCheckpoint>;
  if (row.version !== 1 || !Array.isArray(row.messages) || !Number.isInteger(row.iteration)
    || (row.iteration ?? -1) < 0 || typeof row.worldRevision !== "string" || !row.worldRevision
    || typeof row.requiredCredits !== "number" || !Number.isFinite(row.requiredCredits) || row.requiredCredits < 0) return null;
  if (row.claim && (typeof row.claim.id !== "string" || !row.claim.id || typeof row.claim.claimedAt !== "string")) return null;
  if (row.reason !== undefined && typeof row.reason !== "string") return null;
  if (row.phase === "preflight") return row.generated === undefined ? row as StudioCreditCheckpoint : null;
  if (row.phase !== "generated" || !row.generated) return null;
  const generated = row.generated;
  if (typeof generated.textContent !== "string" || !Array.isArray(generated.toolCalls)
    || typeof generated.usageLogId !== "string" || !generated.usageLogId
    || typeof generated.cost !== "number" || !Number.isFinite(generated.cost) || generated.cost < 0) return null;
  if (generated.billingUnavailable !== undefined && typeof generated.billingUnavailable !== "boolean") return null;
  if (generated.settled !== undefined && typeof generated.settled !== "boolean") return null;
  return row as StudioCreditCheckpoint;
}

/**
 * What a stale checkpoint becomes when the world moved on under it. The
 * revision guard exists so a result the model computed from an older world is
 * never applied over a newer editor save — but a preflight step has generated
 * nothing yet, so it simply continues against the world as it is now, and an
 * UNPAID generated result is dropped and regenerated: the creator never paid
 * for it, and the step costs the same to redo as it would have to settle.
 * A PAID result stays put (null): discarding it would double-charge and
 * applying it is exactly the overwrite the guard prevents. Before this, every
 * stale checkpoint was a dead end — 7 days of prod (2026-09-21): 15 runs, 9
 * creators, rage-clicking a Refresh button that could never change anything.
 */
export function rebaseStudioCreditCheckpoint(checkpoint: StudioCreditCheckpoint, revision: string): StudioCreditCheckpoint | null {
  if (!canRebaseStudioCreditCheckpoint(checkpoint)) return null;
  const { reason, ...rest } = checkpoint;
  const kept = reason !== undefined && reason !== "STALE_WORLD" ? { reason } : {};
  if (checkpoint.phase === "preflight") return { ...rest, ...kept, worldRevision: revision };
  const { generated: _dropped, ...base } = rest;
  return { ...base, ...kept, phase: "preflight", worldRevision: revision };
}

/** A stale checkpoint the creator can still continue from. The DB keeps the
 * STALE_WORLD diagnostic either way; only the public "resumable" flag differs. */
export function canRebaseStudioCreditCheckpoint(checkpoint: StudioCreditCheckpoint): boolean {
  return checkpoint.phase === "preflight" || !checkpoint.generated.settled;
}

/** Persist an unaffordable step without discarding its already-generated result. */
export async function pauseStudioForCredits(
  scope: StudioCreditScope,
  checkpoint: StudioCreditCheckpoint,
  expectedClaimId?: string,
  reason?: string,
): Promise<boolean> {
  const payload = reason === undefined ? checkpoint : { ...checkpoint, reason };
  if (!readStudioCreditCheckpoint(payload)) throw new StudioCreditCheckpointError("INVALID_CHECKPOINT");
  return db.transaction(async tx => {
    if (!await lockedWorld(tx, scope)) return false;
    const [run] = await tx.select().from(agentRuns).where(scopedRun(scope)).for("update");
    if (!run || run.status !== "running") return false;
    const current = readStudioCreditCheckpoint(run.creditCheckpoint);
    if ((current?.claim?.id ?? undefined) !== expectedClaimId) return false;
    const { claim: _claim, ...unclaimed } = payload;
    await tx.update(agentRuns).set({
      status: "awaiting_credits", creditCheckpoint: unclaimed as unknown as Record<string, unknown>,
      messages: checkpoint.messages as unknown as Array<Record<string, unknown>>,
      iteration: checkpoint.iteration,
      textContent: checkpoint.phase === "generated" ? checkpoint.generated.textContent : run.textContent,
      error: null, updatedAt: new Date(),
    }).where(scopedRun(scope));
    return true;
  });
}

/**
 * Journal a funded preflight BEFORE calling the provider, or its generated
 * result BEFORE charging/applying it. Both carry a worker claim: even SIGKILL
 * during generation leaves a recoverable step once that worker's lease expires.
 */
export async function stageStudioCreditIteration(
  scope: StudioCreditScope,
  checkpoint: StudioCreditCheckpoint,
  expectedClaimId?: string,
  opts?: {
    /** `pause` (default) parks the run as a stale pause. `reject` reports the
     *  stale world and writes nothing, for a caller that restarts the step
     *  itself against the current world instead of stranding the run. */
    staleWorld?: "pause" | "reject";
  },
) {
  if (!readStudioCreditCheckpoint(checkpoint)) {
    throw new StudioCreditCheckpointError("INVALID_CHECKPOINT");
  }
  return db.transaction(async tx => {
    const world = await lockedWorld(tx, scope);
    if (!world) return { ok: false as const, code: "NOT_FOUND" as const };
    const [run] = await tx.select().from(agentRuns).where(scopedRun(scope)).for("update");
    if (!run) return { ok: false as const, code: "NOT_FOUND" as const };
    const previous = readStudioCreditCheckpoint(run.creditCheckpoint);
    if (run.status !== "running" || (previous?.claim?.id ?? undefined) !== expectedClaimId) {
      return { ok: false as const, code: "CLAIM_LOST" as const };
    }
    const current = await worldState(tx, world);
    const { claim: _claim, ...body } = checkpoint;
    if (current.revision !== checkpoint.worldRevision) {
      if (opts?.staleWorld === "reject") return { ok: false as const, code: "STALE_WORLD" as const };
      // Keep the generated work for inspection, but it may not overwrite a
      // newer editor save. Normal resume will continue to reject this revision.
      await tx.update(agentRuns).set({ status: "awaiting_credits", creditCheckpoint: { ...body, reason: "STALE_WORLD" },
        messages: checkpoint.messages as unknown as Array<Record<string, unknown>>,
        iteration: checkpoint.iteration, textContent: checkpoint.phase === "generated" ? checkpoint.generated.textContent : run.textContent,
        error: "STALE_WORLD", updatedAt: new Date(),
      }).where(scopedRun(scope));
      return { ok: false as const, code: "STALE_WORLD" as const };
    }
    const claimId = expectedClaimId ?? randomUUID();
    const claimed = { ...body, claim: { id: claimId, claimedAt: new Date().toISOString() } } as StudioCreditCheckpoint;
    await tx.update(agentRuns).set({
      creditCheckpoint: claimed as unknown as Record<string, unknown>,
      messages: checkpoint.messages as unknown as Array<Record<string, unknown>>,
      iteration: checkpoint.iteration, textContent: checkpoint.phase === "generated" ? checkpoint.generated.textContent : run.textContent,
      updatedAt: new Date(),
    }).where(scopedRun(scope));
    return { ok: true as const, claimId, checkpoint: claimed, workingSchema: current.schema };
  });
}

/** Claims never erase the payload. A competing resume gets NOT_PAUSED. */
export async function claimStudioCreditResume(scope: StudioCreditScope) {
  return db.transaction(async tx => {
    const world = await lockedWorld(tx, scope);
    if (!world) return { ok: false as const, code: "NOT_FOUND" as const };
    const [run] = await tx.select().from(agentRuns).where(scopedRun(scope)).for("update");
    if (!run) return { ok: false as const, code: "NOT_FOUND" as const };
    const stored = readStudioCreditCheckpoint(run.creditCheckpoint);
    if (!isStudioCreditResumeEligible(run, stored)) return { ok: false as const, code: "NOT_PAUSED" as const };
    if (!stored) return { ok: false as const, code: "INVALID_CHECKPOINT" as const };
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.worldId, scope.worldId), ne(agentRuns.id, scope.runId), eq(agentRuns.status, "running"))).limit(1);
    if (active) return { ok: false as const, code: "ACTIVE_RUN" as const };
    const current = await worldState(tx, world);
    let checkpoint = stored;
    let rebased = false;
    if (current.revision !== stored.worldRevision) {
      // The creator kept editing while this was paused (that is the normal
      // case: a pause outlives a save). Continue against the world as it is
      // now; only a paid, unapplied result must still refuse.
      const next = rebaseStudioCreditCheckpoint(stored, current.revision);
      if (!next) {
        await tx.update(agentRuns).set({ creditCheckpoint: { ...stored, reason: "STALE_WORLD" } }).where(scopedRun(scope));
        return { ok: false as const, code: "STALE_WORLD" as const };
      }
      checkpoint = next;
      rebased = true;
    }
    const claimId = randomUUID();
    const claimed = { ...checkpoint, claim: { id: claimId, claimedAt: new Date().toISOString() } };
    await tx.update(agentRuns).set({
      status: "running", creditCheckpoint: claimed as unknown as Record<string, unknown>, error: null, updatedAt: new Date(),
    }).where(scopedRun(scope));
    return { ok: true as const, claimId, run, checkpoint: claimed, workingSchema: current.schema, rebased };
  });
}

/** Restore only our own claim after an unsuccessful attempt. No payload is lost. */
export async function restoreStudioCreditPause(scope: StudioCreditScope, claimId: string, reason?: string): Promise<boolean> {
  return db.transaction(async tx => {
    if (!await lockedWorld(tx, scope)) return false;
    const [run] = await tx.select().from(agentRuns).where(scopedRun(scope)).for("update");
    const checkpoint = readStudioCreditCheckpoint(run?.creditCheckpoint);
    if (!run || run.status !== "running" || checkpoint?.claim?.id !== claimId) return false;
    const { claim: _claim, ...unclaimed } = reason === undefined ? checkpoint : { ...checkpoint, reason };
    await tx.update(agentRuns).set({
      status: "awaiting_credits", creditCheckpoint: unclaimed, error: null, updatedAt: new Date(),
    }).where(scopedRun(scope));
    return true;
  });
}

/**
 * Run resumed mutations and their checkpoint update in one transaction. Callers
 * MUST use `tx` for world writes/billing; nested savepoints on that handle are
 * safe, but an independent DB transaction is not. Clearing the checkpoint
 * commits consumption with the writes;
 * a crash or thrown error rolls everything back, leaving the exact result.
 */
export async function withStudioCreditClaimTransaction<T>(
  scope: StudioCreditScope,
  claimId: string,
  work: (tx: StudioCreditTransaction, checkpoint: StudioCreditCheckpoint, workingSchema: Record<string, unknown>) => Promise<{
    value: T;
    checkpoint: StudioCreditCheckpoint | null;
    status?: "running" | "completed" | "awaiting_credits" | "awaiting_user" | "awaiting_approval" | "error";
    runUpdates?: Pick<Partial<typeof agentRuns.$inferInsert>, "messages" | "iteration" | "textContent" | "committedTurns" | "pendingToolCalls" | "readToolResults" | "error">;
  }>,
  opts?: {
    /** The caller applies nothing computed from the checkpoint's world (it
     *  closes an iteration or consumes the claim), so a newer editor save is
     *  not a conflict: the next step simply starts from the current world. */
    rebase?: boolean;
  },
): Promise<{ value: T; checkpoint: StudioCreditCheckpoint | null }> {
  return db.transaction(async tx => {
    const world = await lockedWorld(tx, scope);
    if (!world) throw new StudioCreditCheckpointError("NOT_FOUND");
    const [run] = await tx.select().from(agentRuns).where(scopedRun(scope)).for("update");
    const checkpoint = readStudioCreditCheckpoint(run?.creditCheckpoint);
    if (!run || run.status !== "running" || checkpoint?.claim?.id !== claimId) throw new StudioCreditCheckpointError("CLAIM_LOST");
    const current = await worldState(tx, world);
    if (!opts?.rebase && current.revision !== checkpoint.worldRevision) throw new StudioCreditCheckpointError("STALE_WORLD");
    const result = await work(tx, checkpoint, current.schema);
    const status = result.status ?? "running";
    if (status === "awaiting_credits" && !result.checkpoint) throw new StudioCreditCheckpointError("INVALID_CHECKPOINT");
    let nextCheckpoint: StudioCreditCheckpoint | null = null;
    if (result.checkpoint) {
      if (!readStudioCreditCheckpoint(result.checkpoint)) throw new StudioCreditCheckpointError("INVALID_CHECKPOINT");
      const nextWorld = await lockedWorld(tx, scope);
      if (!nextWorld) throw new StudioCreditCheckpointError("NOT_FOUND");
      const next = await worldState(tx, nextWorld);
      const { claim: _claim, ...body } = result.checkpoint;
      nextCheckpoint = { ...body, worldRevision: next.revision,
        ...(status === "running" ? { claim: checkpoint.claim } : {}),
      } as StudioCreditCheckpoint;
    }
    await tx.update(agentRuns).set({
      ...result.runUpdates, status, creditCheckpoint: nextCheckpoint as unknown as Record<string, unknown> | null,
      updatedAt: new Date(),
    }).where(scopedRun(scope));
    return { value: result.value, checkpoint: nextCheckpoint };
  });
}
