import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { user } from "../../db/schema.js";
import type { AppEnv } from "../types.js";

/**
 * The assistant playing the card the way a player does.
 *
 * Nothing here imitates the game: a throwaway (ephemeral) session is made
 * through the real sessions route, and every move goes through the real turn
 * route — prompt, the card's own model, parsing, effects, behaviours, memory.
 * Both are called in-process as the creator, so a playtest costs what the
 * creator's own turns cost and sees exactly what a player would.
 */

export interface PlaytestTurn {
  player: string;
  reply: string;
  /** Variables that changed this turn, as the turn route reports them. */
  stateChanges?: unknown;
  firedIds?: string[];
  notifications?: unknown[];
  injectedEntryIds?: string[];
  error?: string;
}

export interface PlaytestResult {
  sessionId: string;
  turns: PlaytestTurn[];
  /** Variable values after the last turn. */
  finalState?: unknown;
}

type Routes = { routes: Array<{ method: string; path: string; handler: (...args: never[]) => unknown }> };

async function loadRoutes() {
  // Imported lazily: the turn route is large and pulls in most of the server.
  const [{ sessionRoutes }, { messageRoutes }] = await Promise.all([
    import("../../routes/sessions.js"),
    import("../../routes/messages.js"),
  ]);
  return { sessionRoutes: sessionRoutes as unknown as Routes, messageRoutes: messageRoutes as unknown as Routes };
}

/** One route, called in-process as `userId` (auth middleware skipped, its
 *  result supplied). Every handler registered for the path runs in order. */
async function call(routes: Routes, method: "POST" | "DELETE", pattern: string, url: string, who: AppEnv["Variables"]["user"], body?: unknown) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", who); await next(); });
  const handlers = routes.routes.filter((r) => r.method === method && r.path === pattern).map((r) => r.handler);
  if (handlers.length === 0) throw new Error(`No ${method} ${pattern} route`);
  (app.on as unknown as (m: string, p: string, ...h: unknown[]) => void)(method, pattern, ...handlers);
  return app.request(url, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

/** The `done` (or `error`) event of a turn's SSE stream. */
function readTurn(text: string): { done?: Record<string, unknown>; error?: string } {
  let error: string | undefined;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const event = /^event: ?(.+)$/m.exec(frame)?.[1]?.trim();
    const data = /^data: ?(.+)$/m.exec(frame)?.[1];
    if (!event || !data) continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (event === "done") return { done: parsed };
      if (event === "error") error = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : data;
    } catch {
      if (event === "error") error = data;
    }
  }
  return { error: error ?? "The turn ended without a reply" };
}

export async function runPlaytest(opts: {
  userId: string;
  worldId: string;
  moves: string[];
  /** After each turn: the panel follows along. */
  onTurn?: (info: { sessionId: string; index: number; total: number; turn: PlaytestTurn }) => Promise<void> | void;
  /** Before the first move: the session exists, the opening is on screen. */
  onSession?: (sessionId: string) => Promise<void> | void;
  shouldStop?: () => boolean;
}): Promise<PlaytestResult> {
  const [row] = await db.select().from(user).where(eq(user.id, opts.userId)).limit(1);
  if (!row) throw new Error("Creator not found");
  const who = row as unknown as AppEnv["Variables"]["user"];
  const { sessionRoutes, messageRoutes } = await loadRoutes();

  const created = await call(sessionRoutes, "POST", "/", "/", who, { worldId: opts.worldId, ephemeral: true });
  const createdBody = await created.json().catch(() => null) as { data?: { id?: string }; error?: string } | null;
  const sessionId = createdBody?.data?.id;
  if (!created.ok || !sessionId) throw new Error(createdBody?.error ?? `Could not start a playtest (${created.status})`);
  await opts.onSession?.(sessionId);

  const turns: PlaytestTurn[] = [];
  let finalState: unknown;
  for (const [index, move] of opts.moves.entries()) {
    if (opts.shouldStop?.()) break;
    const response = await call(messageRoutes, "POST", "/sessions/:sessionId/messages", `/sessions/${sessionId}/messages`, who, { content: move });
    let turn: PlaytestTurn;
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const failure = await response.json().catch(() => null) as { error?: string } | null;
      turn = { player: move, reply: "", error: failure?.error ?? `Turn failed (${response.status})` };
    } else {
      const { done, error } = readTurn(await response.text());
      turn = done
        ? {
            player: move,
            reply: typeof done.content === "string" ? done.content : "",
            stateChanges: done.stateChanges,
            firedIds: Array.isArray(done.firedIds) ? done.firedIds as string[] : undefined,
            notifications: Array.isArray(done.notifications) ? done.notifications : undefined,
            injectedEntryIds: Array.isArray(done.injectedEntryIds) ? done.injectedEntryIds as string[] : undefined,
          }
        : { player: move, reply: "", error };
      if (done?.state !== undefined) finalState = done.state;
    }
    turns.push(turn);
    await opts.onTurn?.({ sessionId, index, total: opts.moves.length, turn });
    // A turn that failed (no credits, no key, the model down) will fail again.
    if (turn.error) break;
  }
  return { sessionId, turns, finalState };
}

/** What the assistant reads back: enough to judge each turn, short enough
 *  not to flood its context. */
export function summarizePlaytest(result: PlaytestResult): string {
  const lines: string[] = [`Playtest session ${result.sessionId}: ${result.turns.length} turn(s).`];
  result.turns.forEach((turn, i) => {
    lines.push(`\n--- Turn ${i + 1} ---`);
    lines.push(`Player: ${turn.player}`);
    if (turn.error) { lines.push(`ERROR: ${turn.error}`); return; }
    const reply = turn.reply.length > 1200 ? `${turn.reply.slice(0, 1200)}… (${turn.reply.length} chars)` : turn.reply;
    lines.push(`Reply: ${reply}`);
    if (turn.stateChanges !== undefined) lines.push(`Variable changes: ${JSON.stringify(turn.stateChanges).slice(0, 600)}`);
    if (turn.firedIds?.length) lines.push(`Behaviors fired: ${turn.firedIds.join(", ")}`);
    if (turn.notifications?.length) lines.push(`Notifications: ${JSON.stringify(turn.notifications).slice(0, 300)}`);
    if (turn.injectedEntryIds?.length) lines.push(`Lore used: ${turn.injectedEntryIds.join(", ")}`);
  });
  if (result.finalState !== undefined) lines.push(`\nState after the last turn: ${JSON.stringify(result.finalState).slice(0, 800)}`);
  return lines.join("\n");
}
