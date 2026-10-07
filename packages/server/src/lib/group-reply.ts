import { and, desc, eq } from "drizzle-orm";
import {
  buildMessageAIEvent,
  computeActiveWorldbookIds,
  filterAiEffects,
  followingVoices,
  GameStateManager,
  PromptBuilder,
  ReactionEvaluator,
  ResponseParser,
  replyRoom,
  resolveStation,
  runReactionChain,
  workerModules,
  type GameEvent,
  type GameState,
  type ReplyRoom,
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
import { stripStageNotes } from "./quiet-station.js";
import { checkBalance, validateModelAccess } from "./credit-service.js";
import { scheduleWorkerRun } from "./worker-station.js";
import { resolveProviderForModel } from "./resolve-provider.js";

/**
 * Group replies — the second and later voices of a room.
 *
 * A situation with several AIs in it, or a card with AIs living on it beside
 * its narrator, is a group chat: the player says one thing and each voice in
 * the room answers, one after the other. The first answer is the ordinary
 * reply (the room's first voice is the turn's narrator). Each later one is
 * asked for here, by the open game, once the answer before it has landed — so
 * every voice reads what the earlier ones just said, and the player watches
 * them arrive one by one instead of waiting for all of them.
 *
 * A stored group reply carries its voice on the swipe (`voice`) and opens its
 * raw text with a speaker tag, so the chat names who is talking.
 */

const MAX_GROUP_TOKENS = 900;
const HISTORY_TAIL = 24;

const promptBuilder = new PromptBuilder();
const responseParser = new ResponseParser();
const reactionEvaluator = new ReactionEvaluator();

/** The tag a reply's raw text opens with when an AI that lives on the card or
 *  in a situation said it. A situation that is its own AI narrates; it has no
 *  name to put over its lines. */
export function voiceTag(world: WorldDefinition, stationId: string | null | undefined): string {
  if (!stationId) return "";
  const book = (world.worldbooks ?? []).find((b) => b.id === stationId);
  return book && book.host !== undefined && book.name.trim() ? `[speaker: ${book.name.trim()}]\n` : "";
}

interface TurnRow {
  id: string;
  role: string;
  content: string;
  status: string;
  voice: string | null;
}

/**
 * Who answers next, given the messages since the player last spoke. Nobody
 * when the turn has no answer yet (the first voice failed or is still
 * streaming), or when every voice in the room has had its say.
 */
export function nextVoice(args: {
  world: WorldDefinition;
  state: GameState;
  turn: TurnRow[];
}): Worldbook | null {
  const books = args.world.worldbooks ?? [];
  if (books.length === 0) return null;
  if (args.turn.some((m) => m.status === "streaming")) return null;
  const answered = args.turn.filter((m) => m.role === "assistant" && m.status !== "failed");
  if (answered.length === 0) return null;
  const spoke = new Set(answered.map((m) => m.voice).filter((v): v is string => !!v));
  const followers = followingVoices(books, computeActiveWorldbookIds(books, args.state));
  return followers.find((f) => !spoke.has(f.id)) ?? null;
}

const nameOf = (member: Worldbook | null, narrator: string) => (member ? member.name : narrator);

/** A model this player can actually run, or null — the same two checks the
 *  turn makes for a narrator's own model (station-model.ts): a provider to
 *  reach it, and a plan that allows it. The model in the request is the
 *  player's, but a request is not proof. */
async function runnableModel(userId: string, wanted: string | null | undefined): Promise<string | null> {
  const model = wanted?.trim();
  if (!model) return null;
  try {
    const provider = await resolveProviderForModel(userId, model);
    if (!provider) return null;
    if (!provider.isByok) {
      const wallet = await checkBalance(userId);
      const access = await validateModelAccess(wallet?.wallet.plan ?? "free", model);
      if (!access.allowed) return null;
    }
    return model;
  } catch {
    return null;
  }
}

export function buildGroupReplyPrompt(args: {
  world: WorldDefinition;
  state: GameState;
  voice: Worldbook;
  room: ReplyRoom;
  /** Oldest first; `voice` is the AI that said an assistant line, if one did. */
  history: Array<{ role: string; content: string; voice?: string | null }>;
  scene?: LiveScene | null;
}): ChatMessage[] {
  const books = args.world.worldbooks ?? [];
  const entriesOf = (bookId: string, cap: number) =>
    (args.world.entries ?? [])
      .filter((e) => e.worldbookId === bookId && e.enabled !== false && e.role !== "greeting")
      .map((e) => e.content)
      .filter(Boolean)
      .join("\n\n")
      .slice(0, cap);
  const persona = entriesOf(args.voice.id, 6000);
  // The card's own world, and the place the room is in: a voice in a group
  // has to know whose story it is and where it is standing.
  const worldLore = (args.world.entries ?? [])
    .filter((e) => !e.worldbookId && e.enabled !== false && e.alwaysSend && e.role !== "greeting")
    .map((e) => e.content)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000);
  const placeLore = args.room.id !== "card" ? entriesOf(args.room.id, 3000) : "";
  const narrator = "the narrator";
  const others = args.room.members.filter((m) => m?.id !== args.voice.id).map((m) => nameOf(m, narrator));
  const directives = promptBuilder.buildStaticFormatBlock(args.world, {});
  const values = promptBuilder.buildFormatBlock(args.world, args.state, []);
  const name = args.voice.name.trim() || "you";
  const system = [
    `You are ${name}, one of several voices in an interactive story${others.length ? ` — the others here are ${others.join(", ")}` : ""}. The player has just spoken and the voices answer one after another. It is your turn now.`,
    worldLore ? `The story:\n${worldLore}` : "",
    placeLore ? `Where this happens:\n${placeLore}` : "",
    persona ? `Who you are:\n${persona}` : "",
    directives ?? "",
    values ?? "",
    args.scene ? liveSceneMessage(args.scene).content : "",
    `Answer as ${name} only: what you say and do, in the story's own language, in one to three short paragraphs. React to the player and to what was just said. Never speak or act for the player, never write another voice's lines, and do not repeat what was already said this turn. Value directives, if any, go after your words.`,
  ].filter(Boolean).join("\n\n");
  const byId = new Map(books.map((b) => [b.id, b]));
  const firstVoice = args.room.members[0] ?? null;
  return [
    { role: "system", content: system },
    ...args.history.map((m): ChatMessage => {
      if (m.role === "user") return { role: "user", content: m.content };
      // Who said each line: the stored text has no names, and a voice that
      // cannot tell its own lines from the others' answers for them.
      const speaker = m.voice ? byId.get(m.voice)?.name : firstVoice?.name;
      return { role: "assistant", content: speaker ? `${speaker}: ${m.content}` : m.content };
    }),
    { role: "user", content: `(${name})` },
  ];
}

/** A reply that opens with its own name — `Name:` or a speaker tag — loses it:
 *  the chat puts the name over the bubble. */
export function stripOwnName(text: string, name: string): string {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return text;
  return text
    .replace(/^\s*\[speaker:[^\]]*\]\s*/i, "")
    .replace(new RegExp(`^\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[:：]\\s*`), "")
    .trim();
}

export type GroupReplyResult =
  | { ran: false; reason: "none" | "busy" }
  | {
      ran: true;
      voice: { id: string; name: string };
      message: {
        id: string;
        role: "assistant";
        content: string;
        createdAt: string;
        swipes: Array<{ content: string; rawContent: string; voice: string; createdAt: string; model: string }>;
        activeSwipeIndex: number;
      } | null;
      state: GameState;
      changes: Array<{ variableId: string; oldValue: unknown; newValue: unknown }>;
      storyEvents: string[];
      firedIds: string[];
      notifications: unknown[];
    };

export async function runGroupReply(args: {
  sessionId: string;
  userId: string;
  world: WorldDefinition;
  /** The model the player is chatting with; a voice's own model wins. */
  model?: string | null;
  scene?: LiveScene | null;
}): Promise<GroupReplyResult> {
  const { sessionId, userId, world } = args;
  const books = world.worldbooks ?? [];
  if (!books.some((b) => b.host !== undefined && resolveStation(b)?.kind === "narrator")) return { ran: false, reason: "none" };

  const [session] = await db
    .select({ state: playSessions.state, summaryModel: playSessions.summaryModel })
    .from(playSessions)
    .where(eq(playSessions.id, sessionId))
    .limit(1);
  if (!session) return { ran: false, reason: "none" };
  const state = normalizeGameState(world, session.state as Record<string, unknown>);

  const tail = (await db
    .select({ id: messages.id, role: messages.role, content: messages.content, status: messages.status, swipes: messages.swipes, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(HISTORY_TAIL))
    .reverse()
    .map((m) => ({
      ...m,
      voice: ((m.swipes ?? [])[0] as { voice?: string } | undefined)?.voice ?? null,
    }));
  const lastUser = tail.map((m) => m.role).lastIndexOf("user");
  if (lastUser < 0) return { ran: false, reason: "none" };
  const turn = tail.slice(lastUser + 1);
  const voice = nextVoice({ world, state, turn });
  if (!voice) return { ran: false, reason: "none" };

  const room = replyRoom(books, computeActiveWorldbookIds(books, state));
  const station = resolveStation(voice);
  const model = applyModelRedirect(
    ((await runnableModel(userId, station?.model)) ?? (await runnableModel(userId, args.model)) ?? (session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL)).trim(),
  );
  const history = tail.filter((m) => m.status !== "failed" && (m.role === "user" || m.role === "assistant"));
  const turnEndsAt = tail[tail.length - 1]?.createdAt?.getTime() ?? 0;
  const who = { id: voice.id, name: voice.name };

  const raw = await generateStorySummaryText({
    userId,
    sessionId,
    model,
    prompt: buildGroupReplyPrompt({
      world, state, voice, room, history, scene: args.scene ?? null,
    }),
    endpoint: "module-worker",
    maxTokens: MAX_GROUP_TOKENS,
  }).catch((err) => {
    console.error(`[Group] ${sessionId} ${voice.id} failed:`, err instanceof Error ? err.message : err);
    return "";
  });
  if (!raw.trim()) return { ran: false, reason: "none" };

  // A thinking model can hand back its thoughts before the answer; only what
  // follows the last </think> is said in the story.
  const parsed = responseParser.parse(raw.includes("</think>") ? raw.slice(raw.lastIndexOf("</think>") + "</think>".length) : raw);
  const storyEvents = takeStoryEvents(parsed.effects, world, args.scene ?? null);
  const says = stripOwnName(stripStageNotes(parsed.cleanText), voice.name);
  if (!says && parsed.effects.length === 0) return { ran: false, reason: "none" };

  const result = await withSessionRowLock(sessionId, async (tx, row) => {
    // The player spoke again, or another tab already answered for this voice:
    // this answer belongs to a moment that has passed.
    const [latest] = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId)))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    if ((latest?.createdAt?.getTime() ?? 0) > turnEndsAt) return null;

    const current = normalizeGameState(world, row.state);
    const manager = new GameStateManager(world, current);
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
    const createdAt = new Date().toISOString();
    const swipe = {
      content: says,
      rawContent: `[speaker: ${voice.name.trim()}]\n${raw}`,
      voice: voice.id,
      stateChanges: allChanges.length > 0 ? (allChanges as unknown as Record<string, unknown>) : undefined,
      stateSnapshot: snapshot,
      createdAt,
      model,
    };
    const [inserted] = await tx.insert(messages).values({
      sessionId,
      role: "assistant",
      content: says,
      stateChanges: allChanges.length > 0 ? (allChanges as unknown as Record<string, unknown>) : null,
      stateSnapshot: snapshot,
      model,
      swipes: [swipe],
    }).returning();
    await tx.update(playSessions)
      .set({ state: finalState as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(playSessions.id, sessionId));
    return {
      message: inserted
        ? {
            id: inserted.id,
            role: "assistant" as const,
            content: says,
            createdAt: (inserted.createdAt ?? new Date()).toISOString(),
            swipes: [{ content: says, rawContent: swipe.rawContent, voice: voice.id, createdAt, model }],
            activeSwipeIndex: 0,
          }
        : null,
      state: finalState,
      changes: allChanges,
      storyEvents,
      firedIds: rules.firedIds,
      notifications: rules.notifications,
    };
  }).catch((err) => {
    console.error(`[Group] ${sessionId} ${voice.id} store failed:`, err instanceof Error ? err.message : err);
    return null;
  });
  if (!result || result === SESSION_NOT_FOUND) return { ran: false, reason: "busy" };
  console.log(`[Group] ${sessionId} ${voice.id} answered (${says.length} chars)`);

  // An AI behind the scenes that waits for this voice ("after 店猫 answers")
  // wakes now, the same as one waiting for the turn's first voice.
  const waiting = workerModules(books).filter((b) => {
    const trigger = resolveStation(b)?.trigger;
    return trigger?.on === "after" && trigger.from === voice.id;
  });
  if (waiting.length > 0) {
    const [row] = await db
      .select({ runMemories: playSessions.runMemories })
      .from(playSessions)
      .where(eq(playSessions.id, sessionId))
      .limit(1);
    const generation = (row?.runMemories as { generation?: string } | null)?.generation;
    const active = computeActiveWorldbookIds(books, result.state);
    for (const book of waiting) {
      if (!active.has(book.id)) continue;
      scheduleWorkerRun({
        sessionId,
        userId,
        worldName: world.name,
        worldDef: world,
        book,
        state: result.state,
        cause: { on: "after", bookId: voice.id },
        expectedGeneration: generation,
      });
    }
  }
  return { ran: true, voice: who, ...result };
}
