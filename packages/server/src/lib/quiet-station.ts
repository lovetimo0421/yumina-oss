import { and, desc, eq } from "drizzle-orm";
import {
  buildMessageAIEvent,
  computeActiveWorldbookIds,
  filterAiEffects,
  GameStateManager,
  PromptBuilder,
  ReactionEvaluator,
  ResponseParser,
  resolveStation,
  runReactionChain,
  workerModules,
  type GameEvent,
  type GameState,
  type WorldDefinition,
  type Worldbook,
} from "@yumina/engine";
import { db } from "../db/index.js";
import { messages, playSessions } from "../db/schema.js";
import { normalizeGameState } from "./game-state.js";
import type { ChatMessage } from "./llm/types.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { DEFAULT_STORY_SUMMARY_MODEL, generateStorySummaryText } from "./session-compaction.js";
import { thinSnapshotForStorage } from "./snapshot.js";
import { SESSION_NOT_FOUND, withSessionRowLock } from "./session-lock.js";
import { liveSceneMessage, takeStoryEvents, type LiveScene } from "./live-scene.js";

/**
 * Quiet stations — the AIs on a card that speak when nothing has happened.
 *
 * Every other AI call on Yumina hangs off the player pressing send. A card that
 * says "every moment you stay in the mine, the corrosion rises" was promising
 * something no part of the platform could keep. A quiet station is a worker
 * whose trigger is time: while its module is active and the story has been
 * still for N seconds, it is asked whether this moment is worth a line. It
 * answers with narration (and value directives, through the same AI write
 * filter as any reply) or with `[silent]`.
 *
 * The clock is the player's open game: the client asks `quiet-tick` every few
 * seconds while the page is visible. Nothing runs for a closed tab, so nothing
 * is spent on a player who left.
 */

const MAX_QUIET_TOKENS = 900;
/** The same event from the same scene is delivered once per this long. */
const EVENT_REPEAT_MS = 120_000;
const HISTORY_TAIL = 12;
const SILENT = /^\s*\[?\s*silent\s*\]?\s*$/i;

const promptBuilder = new PromptBuilder();
const responseParser = new ResponseParser();
const reactionEvaluator = new ReactionEvaluator();

export interface QuietSpeaker {
  book: Worldbook;
  seconds: number;
  task: string;
  /** Called by the player's screen (trigger { on: "ui" }) rather than woken
   *  by silence: it runs now, and its prompt says it was asked. */
  called?: boolean;
}

/** Active quiet stations that have a job. A module that is off is not in the room. */
export function quietSpeakers(world: WorldDefinition, state: GameState): QuietSpeaker[] {
  const books = world.worldbooks ?? [];
  const active = computeActiveWorldbookIds(books, state);
  const out: QuietSpeaker[] = [];
  for (const book of workerModules(books)) {
    if (!active.has(book.id)) continue;
    const station = resolveStation(book);
    const trigger = station?.trigger;
    const task = station?.task?.trim();
    if (trigger?.on !== "quiet" || !task) continue;
    out.push({ book, seconds: trigger.seconds, task });
  }
  return out;
}

/** The AI the player's screen just called, if it is in play and has a job.
 *  Matched by id or by name: card code writes whichever it knows. */
export function calledSpeaker(world: WorldDefinition, state: GameState, call: string): QuietSpeaker | null {
  const books = world.worldbooks ?? [];
  const active = computeActiveWorldbookIds(books, state);
  const book = workerModules(books).find((b) => (b.id === call || b.name === call) && resolveStation(b)?.trigger?.on === "ui");
  // An AI on the card or in a situation is in play while that place is.
  const host = book?.host;
  const inPlay = !!book && (host === undefined ? active.has(book.id) : host === "card" || active.has(host));
  const task = book ? resolveStation(book)?.task?.trim() : "";
  if (!book || !inPlay || !task || book.enabled === false) return null;
  return { book, seconds: 0, task, called: true };
}

/** Does this card have any quiet station at all — the client's cue to keep a clock. */
export function worldHasQuietStations(world: WorldDefinition): boolean {
  return workerModules(world.worldbooks ?? []).some((b) => resolveStation(b)?.trigger?.on === "quiet");
}

/**
 * Which speaker is due. "Quiet" is measured from the later of the last message
 * and this speaker's own last turn, so a speaker that just said nothing waits
 * a full interval before being asked again, and a player who is talking is
 * never interrupted.
 */
export function dueQuietSpeaker(args: {
  speakers: QuietSpeaker[];
  lastRuns: Record<string, string>;
  lastMessageAt: number;
  now: number;
}): { speaker: QuietSpeaker; quietFor: number } | null {
  let best: { speaker: QuietSpeaker; quietFor: number; overdue: number } | null = null;
  for (const speaker of args.speakers) {
    const ran = Date.parse(args.lastRuns[speaker.book.id] ?? "") || 0;
    const since = Math.max(ran, args.lastMessageAt);
    const quietFor = args.now - since;
    const overdue = quietFor - speaker.seconds * 1000;
    if (overdue < 0) continue;
    if (!best || overdue > best.overdue) best = { speaker, quietFor, overdue };
  }
  return best ? { speaker: best.speaker, quietFor: best.quietFor } : null;
}

export function buildQuietPrompt(args: {
  world: WorldDefinition;
  state: GameState;
  speaker: QuietSpeaker;
  history: Array<{ role: string; content: string }>;
  quietSeconds: number;
  scene?: LiveScene | null;
}): ChatMessage[] {
  const persona = (args.world.entries ?? [])
    .filter((e) => e.worldbookId === args.speaker.book.id && e.enabled !== false && e.role !== "greeting")
    .map((e) => e.content)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 6000);
  // The card's own world: a voice that steps into the story has to know
  // whose story it is. Always-sent card entries only, never another
  // situation's lore.
  const worldLore = (args.world.entries ?? [])
    .filter((e) => !e.worldbookId && e.enabled !== false && e.alwaysSend && e.role !== "greeting")
    .map((e) => e.content)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000);
  const directives = promptBuilder.buildStaticFormatBlock(args.world, {});
  const values = promptBuilder.buildFormatBlock(args.world, args.state, []);
  // Order matters to a cheap model: what is true now first, the job last,
  // and the decision spelled out — a trailing "or stay silent" alone is the
  // path of least effort, and it takes it every time.
  const called = args.speaker.called === true;
  const system = [
    called
      ? "You are a voice inside an interactive story. The player just called on you from the game's screen (a button, a panel) — answer that call now, inside the story."
      : "You are a voice inside an interactive story that may step in on its own between the player's messages. Nobody asked you anything: time has simply passed.",
    worldLore ? `The story:\n${worldLore}` : "",
    persona ? `Who you are:\n${persona}` : "",
    directives ?? "",
    values ?? "",
    args.scene ? liveSceneMessage(args.scene).content : "",
    called ? "" : `Time: nothing has happened for ${args.quietSeconds} seconds — the player has not said or done anything since the last message.`,
    `Your job:\n${args.speaker.task}`,
    "Decide now. Check your job against the live scene, the values and the time above. If any of its conditions holds, do exactly what it says: a line of narration, value directives, an [event: …] line — whatever it asks for. Only if none of them holds, answer with exactly [silent] and nothing else.",
    "When you speak: one or two short sentences in the story's own language and voice, continuing from the last message. Never speak for the player. Directives go after the narration.",
  ].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: system },
    ...args.history.map((m) => ({ role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant", content: m.content })),
    // The silence itself, as the player's turn. Not a sentence: a sentence in
    // brackets is what small models copy back into the story.
    { role: "user", content: "……" },
  ];
}

/** Lines a model writes ABOUT the prompt rather than in the story — an echoed
 *  "[30 seconds pass]", a "(silence)" placeholder — are not narration. */
export function stripStageNotes(text: string): string {
  return text
    .split("\n")
    // A model that echoes its own role name ("assistant") before the line.
    .filter((line, i) => !(i === 0 && /^\s*(assistant|ai|narrator|旁白)\s*[:：]?\s*$/i.test(line)))
    .filter((line) => !/^\s*[[(（【]\s*(\d+\s*(seconds?|s|秒)|silence|沉默|安静|……|\.\.\.)[^\])）】]*[\])）】]\s*$/i.test(line))
    .join("\n")
    .trim();
}

export type QuietTickResult =
  | { ran: false; reason: "none" | "not-due" | "busy" }
  | { ran: true; spoke: false; speaker: { id: string; name: string } }
  | {
      ran: true;
      /** False when it only moved values: the corrosion rises without a word. */
      spoke: boolean;
      speaker: { id: string; name: string };
      message: { id: string; role: "assistant"; content: string; createdAt: string } | null;
      state: GameState;
      changes: Array<{ variableId: string; oldValue: unknown; newValue: unknown }>;
      changeTrace: unknown;
      storyEvents: string[];
      firedIds: string[];
      notifications: unknown[];
    };

export async function runQuietTick(args: { sessionId: string; userId: string; world: WorldDefinition; scene?: LiveScene | null; call?: string | null }): Promise<QuietTickResult> {
  const { sessionId, userId, world } = args;
  const scene = args.scene ?? null;
  const call = args.call?.trim() || null;
  if (!call && !worldHasQuietStations(world)) return { ran: false, reason: "none" };

  const [session] = await db
    .select({ state: playSessions.state, summaryModel: playSessions.summaryModel })
    .from(playSessions)
    .where(eq(playSessions.id, sessionId))
    .limit(1);
  if (!session) return { ran: false, reason: "none" };
  const state = normalizeGameState(world, session.state as Record<string, unknown>);
  const asked = call ? calledSpeaker(world, state, call) : null;
  if (call && !asked) return { ran: false, reason: "none" };
  const speakers = asked ? [asked] : quietSpeakers(world, state);
  if (speakers.length === 0) return { ran: false, reason: "none" };

  const tail = await db
    .select({ role: messages.role, content: messages.content, status: messages.status, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(HISTORY_TAIL);
  // A reply still streaming is the opposite of quiet.
  if (tail.some((m) => m.status === "streaming")) return { ran: false, reason: "busy" };
  const lastMessageAt = tail[0]?.createdAt?.getTime() ?? 0;
  const lastRuns = (state.metadata?.quietRuns as Record<string, string> | undefined) ?? {};
  const now = Date.now();
  const due = asked ? { speaker: asked, quietFor: now - lastMessageAt } : dueQuietSpeaker({ speakers, lastRuns, lastMessageAt, now });
  if (!due) return { ran: false, reason: "not-due" };

  const { speaker } = due;
  const station = resolveStation(speaker.book);
  const model = applyModelRedirect((station?.model || session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim());
  const history = tail
    .filter((m) => m.status !== "failed" && (m.role === "user" || m.role === "assistant"))
    .reverse();
  const askedAt = new Date(now).toISOString();
  const who = { id: speaker.book.id, name: speaker.book.name };

  // Claim the turn before the model call, so two open tabs ask once.
  const claimed = await withSessionRowLock(sessionId, async (tx, row) => {
    const current = normalizeGameState(world, row.state);
    const runs = (current.metadata?.quietRuns as Record<string, string> | undefined) ?? {};
    if (runs[speaker.book.id] !== lastRuns[speaker.book.id]) return false;
    const manager = new GameStateManager(world, current);
    manager.setMetadata("quietRuns", { ...runs, [speaker.book.id]: askedAt });
    await tx.update(playSessions)
      .set({ state: manager.getSnapshot() as unknown as Record<string, unknown> })
      .where(eq(playSessions.id, sessionId));
    return true;
  }).catch(() => false);
  if (claimed !== true) return { ran: false, reason: "busy" };

  const raw = await generateStorySummaryText({
    userId,
    sessionId,
    model,
    prompt: buildQuietPrompt({
      world, state, speaker, history, quietSeconds: Math.round(due.quietFor / 1000), scene,
    }),
    endpoint: "module-worker",
    maxTokens: MAX_QUIET_TOKENS,
  }).catch((err) => {
    console.error(`[Quiet] ${sessionId} ${speaker.book.id} failed:`, err instanceof Error ? err.message : err);
    return "";
  });
  const outcome = (what: string) => console.log(`[Quiet] ${sessionId} ${speaker.book.id} ${what} (${raw.length} chars)${process.env.NODE_ENV === "production" ? "" : ` ${JSON.stringify(raw.slice(0, 120))}`}`);
  if (!raw.trim() || SILENT.test(raw)) { outcome("silent"); return { ran: true, spoke: false, speaker: who }; }

  const parsed = responseParser.parse(raw);
  const storyEvents = takeStoryEvents(parsed.effects, world, scene);
  const text = stripStageNotes(parsed.cleanText);
  const says = text && !SILENT.test(text) ? text : "";
  // Nothing to say and nothing to change is silence. Values without words is
  // a real answer: time passed and the corrosion rose.
  if (!says && parsed.effects.length === 0 && storyEvents.length === 0) { outcome("silent after cleanup"); return { ran: true, spoke: false, speaker: who }; }

  const result = await withSessionRowLock(sessionId, async (tx, row) => {
    // The player may have spoken while this was thinking. Then the moment
    // passed: a line about the silence would land after the conversation.
    const [latest] = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId)))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    if ((latest?.createdAt?.getTime() ?? 0) > lastMessageAt) return null;

    const current = normalizeGameState(world, row.state);
    const manager = new GameStateManager(world, current);
    // A station that keeps seeing the same scene keeps asking for the same
    // event. Once is the event; the repeats are the knock that never stops.
    const firedAt = (current.metadata?.storyEventsAt as Record<string, string> | undefined) ?? {};
    const nowMs = Date.now();
    storyEvents.splice(0, storyEvents.length, ...storyEvents.filter((name) => nowMs - (Date.parse(firedAt[name] ?? "") || 0) >= EVENT_REPEAT_MS));
    if (storyEvents.length > 0) {
      manager.setMetadata("storyEventsAt", { ...firedAt, ...Object.fromEntries(storyEvents.map((name) => [name, new Date(nowMs).toISOString()])) });
    }
    const filtered = filterAiEffects(world, manager.getSnapshot(), parsed.effects, { judgeRan: false });
    const changes = manager.applyEffects(filtered.kept);
    manager.drainRejectedWrites();
    const events: GameEvent[] = [
      ...(says ? [buildMessageAIEvent(says)] : []),
      ...changes.map((c) => ({ type: "state:changed" as const, variableId: c.variableId, oldValue: c.oldValue, newValue: c.newValue })),
    ];
    const rules = runReactionChain(reactionEvaluator, manager, events, world.reactions ?? [], world.rules ?? [], { worldbooks: world.worldbooks });
    if (rules.contextMessages.length > 0) manager.setMetadata("pendingContext", rules.contextMessages);
    const finalState = manager.getSnapshot();
    const allChanges = [...changes, ...rules.changes];
    const snapshot = thinSnapshotForStorage(finalState as unknown as Record<string, unknown>);
    // Stored like any reply: plain text. The parser already took a speaker tag
    // off (replies never persist one), and the chat shows text as written.
    const content = says;
    const [inserted] = says
      ? await tx.insert(messages).values({
          sessionId,
          role: "assistant",
          content,
          stateChanges: allChanges.length > 0 ? (allChanges as unknown as Record<string, unknown>) : null,
          stateSnapshot: snapshot,
          model,
          swipes: [{
            content,
            rawContent: raw,
            stateChanges: allChanges.length > 0 ? (allChanges as unknown as Record<string, unknown>) : undefined,
            stateSnapshot: snapshot,
            createdAt: new Date().toISOString(),
            model,
          }],
        }).returning()
      : [];
    await tx.update(playSessions)
      .set({ state: finalState as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(playSessions.id, sessionId));
    // Same shape the playtest's "this turn" column reads after a reply.
    const changeTrace = {
      version: 1 as const,
      sources: [
        ...changes.map(() => ({ kind: "ai" as const })),
        ...rules.changes.map((_, i) => {
          const ids = rules.changeCauses[i] ?? [];
          return ids.length > 0 ? { kind: "rule" as const, ids } : { kind: "settle" as const };
        }),
      ],
      dropped: [],
      rejected: [],
      aiWrote: [...new Set(filtered.kept.map((e) => e.variableId.split(/[.[]/)[0]!))],
      judge: [],
    };
    return {
      message: inserted ? { id: inserted.id, role: "assistant" as const, content, createdAt: (inserted.createdAt ?? new Date()).toISOString() } : null,
      state: finalState,
      changes: allChanges,
      changeTrace,
      storyEvents,
      firedIds: rules.firedIds,
      notifications: rules.notifications,
    };
  }).catch(() => null);
  if (!result || result === SESSION_NOT_FOUND) { outcome("moment passed"); return { ran: true, spoke: false, speaker: who }; }
  outcome(result.message ? "spoke" : `changed ${result.changes.length} value(s) without a word`);
  return { ran: true, spoke: result.message !== null, speaker: who, ...result };
}
