import { and, desc, eq } from "drizzle-orm";
import {
  buildMessageAIEvent,
  checkConditions,
  computeActiveWorldbookIds,
  GameStateManager,
  ReactionEvaluator,
  resolveStation,
  runReactionChain,
  type AiOutputField,
  type Effect,
  type GameEvent,
  type GameState,
  type ModuleStation,
  type WorldDefinition,
  type Worldbook,
  sendsEveryTurn,
} from "@yumina/engine";
import { db } from "../db/index.js";
import { messages, playSessions } from "../db/schema.js";
import { normalizeGameState } from "./game-state.js";
import type { ChatMessage } from "./llm/types.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { DEFAULT_STORY_SUMMARY_MODEL, generateStorySummaryText } from "./session-compaction.js";
import { thinSnapshotForStorage } from "./snapshot.js";
import { SESSION_NOT_FOUND, withSessionRowLock } from "./session-lock.js";
import { liveSceneMessage, type LiveScene } from "./live-scene.js";
import { stripStageNotes } from "./quiet-station.js";

/**
 * A card's own AI call, as data (the 自定义 AI).
 *
 * Cards on the platform write the same AI plumbing by hand again and again: a
 * phone contact with its own thread, a forum that answers in JSON, an
 * opponent that may only pick a legal move — each with its own timeout,
 * retry and fallback. Here that plumbing is one runner driven by the AI's
 * station: what it sees, the prompt pieces that hold right now, the answer's
 * fields and where each goes, and what to do when the model fails. The card
 * calls it (`api.callAi(name, input)`) and gets the answer back.
 */

const reactionEvaluator = new ReactionEvaluator();
const THREAD_KEEP = 20;

export interface AiCallAnswer {
  /** The spoken words: the field routed to "say", or the whole answer. */
  text: string;
  fields: Record<string, unknown>;
  /** True when every try failed and a fallback line stands in. */
  fallback: boolean;
}

/** The AI a call names — by id, station name or situation name — if it is in play. */
export function findCalledAi(world: WorldDefinition, state: GameState, ai: string): Worldbook | null {
  const books = world.worldbooks ?? [];
  const wanted = ai.trim();
  const book = books.find((b) => !!b.station && (b.id === wanted || b.station.name === wanted || b.name === wanted));
  if (!book || book.enabled === false) return null;
  const active = computeActiveWorldbookIds(books, state);
  const host = book.host;
  const inPlay = host === undefined ? active.has(book.id) : host === "card" || active.has(host);
  return inPlay ? book : null;
}

function describeField(f: AiOutputField): string {
  const kind = f.type === "number"
    ? `number${f.min !== undefined || f.max !== undefined ? ` between ${f.min ?? "-∞"} and ${f.max ?? "∞"}` : ""}`
    : f.type === "choice" ? `one of: ${(f.options ?? []).map((o) => JSON.stringify(o)).join(", ")}`
    : f.type === "list" ? `array of strings${f.options?.length ? ` (each one of: ${f.options.map((o) => JSON.stringify(o)).join(", ")})` : ""}`
    : "string";
  return `  "${f.name}": ${kind}${f.hint ? ` — ${f.hint}` : ""}`;
}

export function buildAiCallPrompt(args: {
  world: WorldDefinition;
  state: GameState;
  book: Worldbook;
  station: ModuleStation;
  input: string;
  history: Array<{ role: string; content: string }>;
  thread: Array<{ in: string; out: string }>;
  scene?: LiveScene | null;
}): ChatMessage[] {
  const { world, state, book, station } = args;
  const name = station.name?.trim() || book.name;
  const own = (world.entries ?? [])
    .filter((e) => e.worldbookId === book.id && e.enabled !== false && e.role !== "greeting")
    .map((e) => e.content).filter(Boolean).join("\n\n").slice(0, 6000);
  const lore = (world.entries ?? [])
    .filter((e) => !e.worldbookId && e.role !== "greeting" && sendsEveryTurn(e, state.ruleState?.toggledEntries, world.loreUiBindings))
    .map((e) => e.content).filter(Boolean).join("\n\n").slice(0, 4000);
  const vars = (station.sees?.variables ?? [])
    .map((id) => {
      const v = (world.variables ?? []).find((x) => x.id === id);
      return v ? `${v.name}: ${JSON.stringify(state.variables?.[id] ?? v.defaultValue)}` : null;
    })
    .filter(Boolean);
  const pieces = (station.pieces ?? [])
    .filter((p) => p.text.trim() && checkConditions(state, p.conditions ?? [], p.conditionLogic ?? "all"))
    .map((p) => p.text.trim());
  const fields = station.output ?? [];
  const historyText = args.history
    .map((m) => `${m.role === "user" ? "Player" : "Story"}: ${m.content}`)
    .join("\n");
  const system = [
    `You are "${name}", one AI inside an interactive story card. The card's interface has just called you.`,
    lore ? `The story:\n${lore}` : "",
    own ? `Who you are:\n${own}` : "",
    vars.length ? `Current values:\n${vars.join("\n")}` : "",
    args.scene ? liveSceneMessage(args.scene).content : "",
    historyText ? `The latest of the story:\n${historyText}` : "",
    station.task?.trim() ? `Your job:\n${station.task.trim()}` : "",
    pieces.length ? pieces.join("\n\n") : "",
    fields.length
      ? `Answer with ONLY one JSON object, no other text, with exactly these fields:\n{\n${fields.map(describeField).join(",\n")}\n}`
      : "Answer with the words themselves only — no labels, no notes about the prompt.",
  ].filter(Boolean).join("\n\n");
  const thread = args.thread.flatMap((t) => [
    { role: "user" as const, content: t.in || "(called)" },
    { role: "assistant" as const, content: t.out },
  ]);
  return [
    { role: "system", content: system },
    ...thread,
    { role: "user", content: args.input.trim() || "(called)" },
  ];
}

/** Pull one JSON object out of an answer: bare, fenced, or among words. */
export function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(text); } catch { /* look inside */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* not JSON */ }
  }
  return undefined;
}

/** The fields as asked, or the reason they are not. Numbers are clamped;
 *  a choice outside its options, or a missing field, fails the answer. */
export function validateFields(fields: AiOutputField[], value: unknown): { ok: true; fields: Record<string, unknown> } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "not a JSON object" };
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = obj[f.name];
    if (v === undefined || v === null) return { ok: false, reason: `missing "${f.name}"` };
    if (f.type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return { ok: false, reason: `"${f.name}" is not a number` };
      out[f.name] = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
    } else if (f.type === "choice") {
      const s = String(v).trim();
      if (f.options?.length && !f.options.includes(s)) return { ok: false, reason: `"${f.name}" must be one of ${f.options.join(", ")}` };
      out[f.name] = s;
    } else if (f.type === "list") {
      if (!Array.isArray(v)) return { ok: false, reason: `"${f.name}" is not a list` };
      const items = v.map((x) => String(x).trim()).filter(Boolean);
      out[f.name] = f.options?.length ? items.filter((x) => f.options!.includes(x)) : items;
    } else {
      out[f.name] = String(v);
    }
  }
  return { ok: true, fields: out };
}

/** What the answer changes: variables to write and events to set off. */
export function routeFields(fields: AiOutputField[], values: Record<string, unknown>): { effects: Effect[]; events: string[]; say: string | null } {
  const effects: Effect[] = [];
  const events: string[] = [];
  let say: string | null = null;
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined || !f.to) continue;
    if (f.to.kind === "say") say = String(v);
    else if (f.to.kind === "event") {
      const name = (f.to.name?.trim() || String(v)).trim();
      if (name) events.push(name);
    } else if (f.to.kind === "variable") {
      const op = f.to.op ?? "set";
      if (op === "push" && Array.isArray(v)) for (const item of v) effects.push({ variableId: f.to.variableId, operation: "push", value: item as string });
      else effects.push({ variableId: f.to.variableId, operation: op, value: v as number | string });
    }
  }
  return { effects, events, say };
}

/** Every try failed and the AI must still move: a random allowed option for
 *  each choice, the low end for numbers, nothing for lists, the fallback line
 *  for text. */
export function randomFields(fields: AiOutputField[], line: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "choice") {
      const opts = f.options ?? [];
      if (opts.length) out[f.name] = opts[Math.floor(Math.random() * opts.length)];
    } else if (f.type === "number") out[f.name] = f.min ?? 0;
    else if (f.type === "list") out[f.name] = [];
    else out[f.name] = line;
  }
  return out;
}

export type AiCallResult =
  | { ok: false; reason: "none" | "busy" | "cooldown" | "not-found" }
  | {
      ok: true;
      ai: { id: string; name: string };
      answer: AiCallAnswer;
      /** Where the words went: "story", "none", or an interface channel. */
      say: string;
      message: { id: string; role: "assistant"; content: string; createdAt: string } | null;
      state: GameState;
      changes: Array<{ variableId: string; oldValue: unknown; newValue: unknown }>;
      storyEvents: string[];
      firedIds: string[];
      notifications: unknown[];
    };

export async function runAiCall(args: {
  sessionId: string;
  userId: string;
  world: WorldDefinition;
  ai: string;
  input?: string | null;
  scene?: LiveScene | null;
}): Promise<AiCallResult> {
  const { sessionId, userId, world } = args;
  const input = (args.input ?? "").slice(0, 4000);
  const [session] = await db
    .select({ state: playSessions.state, summaryModel: playSessions.summaryModel })
    .from(playSessions)
    .where(eq(playSessions.id, sessionId))
    .limit(1);
  if (!session) return { ok: false, reason: "none" };
  const state = normalizeGameState(world, session.state as Record<string, unknown>);
  const book = findCalledAi(world, state, args.ai);
  const station = book ? resolveStation(book) : null;
  if (!book || !station) return { ok: false, reason: "not-found" };
  const full = book.station!;
  const name = full.name?.trim() || book.name;

  const calls = (state.metadata?.aiCalls as Record<string, string> | undefined) ?? {};
  const now = Date.now();
  if (full.cooldownSec && now - (Date.parse(calls[book.id] ?? "") || 0) < full.cooldownSec * 1000) return { ok: false, reason: "cooldown" };

  const historyN = full.sees?.history ?? 0;
  const history = historyN > 0
    ? (await db
        .select({ role: messages.role, content: messages.content, status: messages.status })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(historyN))
        .filter((m) => m.status !== "failed" && (m.role === "user" || m.role === "assistant"))
        .reverse()
    : [];
  const threads = (state.metadata?.aiThreads as Record<string, Array<{ in: string; out: string }>> | undefined) ?? {};
  const thread = full.sees?.ownThread ? (threads[book.id] ?? []).slice(-THREAD_KEEP) : [];

  // Claim the call before the model runs: one at a time per AI, and the
  // cooldown starts now, so a double tap is one call.
  const calledAt = new Date(now).toISOString();
  const claimed = await withSessionRowLock(sessionId, async (tx, row) => {
    const current = normalizeGameState(world, row.state);
    const latest = (current.metadata?.aiCalls as Record<string, string> | undefined) ?? {};
    if (latest[book.id] !== calls[book.id]) return false;
    const manager = new GameStateManager(world, current);
    manager.setMetadata("aiCalls", { ...latest, [book.id]: calledAt });
    await tx.update(playSessions).set({ state: manager.getSnapshot() as unknown as Record<string, unknown> }).where(eq(playSessions.id, sessionId));
    return true;
  }).catch(() => false);
  if (claimed !== true) return { ok: false, reason: "busy" };

  const model = applyModelRedirect((full.model || session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim());
  const fields = full.output ?? [];
  const prompt = buildAiCallPrompt({ world, state, book, station: full, input, history, thread, scene: args.scene ?? null });
  const timeoutMs = (full.onError?.timeoutSec ?? 25) * 1000;
  const retries = full.onError?.retries ?? 1;

  let answer: AiCallAnswer | null = null;
  let messagesForTry = prompt;
  for (let attempt = 0; attempt <= retries && !answer; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    const raw = await generateStorySummaryText({
      signal, userId, sessionId, model, prompt: messagesForTry, endpoint: "module-worker", maxTokens: full.maxTokens ?? 800,
    }).catch((err) => {
      console.error(`[AiCall] ${sessionId} ${book.id} try ${attempt + 1} failed:`, err instanceof Error ? err.message : err);
      return "";
    });
    if (!raw.trim()) continue;
    if (!fields.length) {
      const text = stripStageNotes(raw);
      if (text) answer = { text, fields: {}, fallback: false };
      continue;
    }
    const checked = validateFields(fields, extractJson(raw));
    if (checked.ok) {
      const spoken = fields.find((f) => f.to?.kind === "say");
      answer = { text: spoken ? String(checked.fields[spoken.name] ?? "") : "", fields: checked.fields, fallback: false };
    } else {
      // Ask once more, saying what was wrong — the repair a hand-written card does.
      messagesForTry = [...prompt, { role: "assistant", content: raw.slice(0, 2000) }, { role: "user", content: `That answer was not usable (${checked.reason}). Reply again with ONLY the JSON object, exactly the fields asked.` }];
    }
  }
  if (!answer) {
    const lines = (full.onError?.fallback ?? []).map((l) => l.trim()).filter(Boolean);
    const line = lines.length ? lines[Math.floor(Math.random() * lines.length)]! : "";
    answer = { text: line, fields: full.onError?.randomChoice ? randomFields(fields, line) : {}, fallback: true };
    if (full.onError?.randomChoice) {
      const spoken = fields.find((f) => f.to?.kind === "say");
      if (spoken) answer.text = String(answer.fields[spoken.name] ?? line);
    }
  }

  const routed = routeFields(fields, answer.fields);
  const say = full.say?.trim() || "story";
  const toStory = say === "story" && !!answer.text.trim();
  const threadOut = fields.length && !answer.fallback ? JSON.stringify(answer.fields) : answer.text;

  const result = await withSessionRowLock(sessionId, async (tx, row) => {
    const current = normalizeGameState(world, row.state);
    const manager = new GameStateManager(world, current);
    // The creator routed these fields here: they are written as asked,
    // whatever the AI may write on its own turn.
    const changes = manager.applyEffects(routed.effects);
    manager.drainRejectedWrites();
    if (full.sees?.ownThread) {
      const all = (current.metadata?.aiThreads as Record<string, Array<{ in: string; out: string }>> | undefined) ?? {};
      manager.setMetadata("aiThreads", { ...all, [book.id]: [...(all[book.id] ?? []), { in: input, out: threadOut }].slice(-THREAD_KEEP) });
    }
    const events: GameEvent[] = [
      ...(toStory ? [buildMessageAIEvent(answer!.text)] : []),
      ...changes.map((c) => ({ type: "state:changed" as const, variableId: c.variableId, oldValue: c.oldValue, newValue: c.newValue })),
    ];
    const rules = runReactionChain(reactionEvaluator, manager, events, world.reactions ?? [], world.rules ?? [], { worldbooks: world.worldbooks });
    if (rules.contextMessages.length > 0) manager.setMetadata("pendingContext", rules.contextMessages);
    const finalState = manager.getSnapshot();
    const allChanges = [...changes, ...rules.changes];
    const snapshot = thinSnapshotForStorage(finalState as unknown as Record<string, unknown>);
    const [inserted] = toStory
      ? await tx.insert(messages).values({
          sessionId,
          role: "assistant",
          content: answer!.text,
          stateChanges: allChanges.length > 0 ? (allChanges as unknown as Record<string, unknown>) : null,
          stateSnapshot: snapshot,
          model,
          swipes: [{ content: answer!.text, rawContent: answer!.text, stateSnapshot: snapshot, createdAt: new Date().toISOString(), model }],
        }).returning()
      : [];
    await tx.update(playSessions).set({ state: finalState as unknown as Record<string, unknown>, updatedAt: new Date() }).where(and(eq(playSessions.id, sessionId)));
    return {
      message: inserted ? { id: inserted.id, role: "assistant" as const, content: answer!.text, createdAt: (inserted.createdAt ?? new Date()).toISOString() } : null,
      state: finalState,
      changes: allChanges,
      firedIds: rules.firedIds,
      notifications: rules.notifications,
    };
  }).catch((err) => {
    console.error(`[AiCall] ${sessionId} ${book.id} apply failed:`, err instanceof Error ? err.message : err);
    return null;
  });
  if (!result || result === SESSION_NOT_FOUND) return { ok: false, reason: "busy" };
  console.log(`[AiCall] ${sessionId} ${book.id} ${answer.fallback ? "fallback" : "answered"} → ${say}`);
  return { ok: true, ai: { id: book.id, name }, answer, say, storyEvents: routed.events, ...result };
}
