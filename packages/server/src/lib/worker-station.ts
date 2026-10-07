import { and, desc, eq, gte, lte, ne, or, sql } from "drizzle-orm";
import {
  checkConditions,
  computeActiveWorldbookIds,
  isAnyModule,
  MODULE_TRANSCRIPT_MAX,
  resolveInputs,
  resolveStation,
  workerModules,
  type GameState,
  type WorldDefinition,
  type Worldbook,
} from "@yumina/engine";
import { db } from "../db/index.js";
import { messages, playSessions } from "../db/schema.js";
import type { ChatMessage } from "./llm/types.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { DEFAULT_STORY_SUMMARY_MODEL, generateStorySummaryText } from "./session-compaction.js";
import { buildSummaryLanguageInstruction, normalizeSessionSummaryLanguage } from "./summary-language.js";
import {
  buildInputBlocksFor,
  type FoldableRow,
  type RunMemories,
  type RunRecord,
  type WorkerOutput,
} from "./run-scopes.js";

/**
 * Worker stations — the AIs on a card that never speak to the player.
 *
 * A dungeon finishes; a chronicler reads what happened and writes three lines
 * for the next dungeon's narrator to open with. That chronicler is a module
 * like any other — its entries are its character, its inputs are what it may
 * look at — except that its turn is triggered by the game rather than by a
 * player, and its answer becomes context instead of a reply.
 *
 * Everything here is fire-and-forget and degrades to silence. A worker that
 * fails leaves a failed record, the consumer's block is simply absent, and the
 * player's turn never waited on any of it.
 */

const MAX_WORKER_TOKENS = 900;

/** Why a worker ran, kept for the creator staring at an empty briefing. */
export type WorkerCause =
  | { on: "module-closed"; bookId: string; runIndex: number }
  | { on: "conditions" }
  | { on: "turns"; turn: number }
  | { on: "after"; bookId: string };

const causeText = (cause: WorkerCause): string =>
  cause.on === "module-closed"
    ? `module-closed:${cause.bookId}#${cause.runIndex}`
    : cause.on === "turns"
      ? `turns:${cause.turn}`
      : cause.on === "after"
        ? `after:${cause.bookId}`
        : "conditions";

/**
 * Which workers this transition should wake.
 *
 * Rising edge only, for the same reason a run opens once: a condition that is
 * true for ten turns is one event, not ten. `turns` fires on the multiple, so
 * "every 5" means turns 5, 10, 15 and nothing in between.
 */
export function dueWorkers(args: {
  worldDef: WorldDefinition;
  prevState: GameState;
  nextState: GameState;
  closedRecords: readonly RunRecord[];
  turnCount?: number;
  /** The module whose AI answered this turn, when one did. */
  answeredBy?: string | null;
}): Array<{ book: Worldbook; cause: WorkerCause }> {
  const books = args.worldDef.worldbooks;
  const workers = workerModules(books);
  if (workers.length === 0) return [];

  const prevActive = computeActiveWorldbookIds(books, args.prevState);
  const nextActive = computeActiveWorldbookIds(books, args.nextState);
  const due: Array<{ book: Worldbook; cause: WorkerCause }> = [];

  for (const book of workers) {
    // A worker's own activation is still its master switch: a chronicler that
    // belongs to chapter two should not write during chapter one.
    if (!nextActive.has(book.id)) continue;
    const trigger = resolveStation(book)?.trigger;
    if (!trigger) continue;

    if (trigger.on === "module-closed") {
      if (isAnyModule(trigger.from)) {
        // One chronicler for every dungeon: it runs once per module that
        // closed this turn, not once for the turn, because two dungeons
        // finishing together are two things to write up. `cause` names which,
        // so the worker's prompt is about that one.
        for (const record of args.closedRecords) {
          if (record.bookId === book.id) continue;
          due.push({ book, cause: { on: "module-closed", bookId: record.bookId, runIndex: record.runIndex } });
        }
        continue;
      }
      const hit = args.closedRecords.find((r) => r.bookId === trigger.from);
      if (hit) due.push({ book, cause: { on: "module-closed", bookId: hit.bookId, runIndex: hit.runIndex } });
      continue;
    }
    if (trigger.on === "conditions") {
      const was = checkConditions(args.prevState, trigger.conditions, trigger.conditionLogic ?? "all");
      const is = checkConditions(args.nextState, trigger.conditions, trigger.conditionLogic ?? "all");
      if (!was && is) due.push({ book, cause: { on: "conditions" } });
      continue;
    }
    if (trigger.on === "turns") {
      const turn = args.turnCount ?? 0;
      if (turn > 0 && turn % trigger.every === 0) due.push({ book, cause: { on: "turns", turn } });
      continue;
    }
    if (trigger.on === "after") {
      if (args.answeredBy && args.answeredBy === trigger.from) due.push({ book, cause: { on: "after", bookId: trigger.from } });
      continue;
    }
    // A worker whose activation just came on but has no trigger stays quiet:
    // "run when I say" is a trigger too, and it is the one the creator wrote.
    void prevActive;
  }
  return due;
}

/** Append a pending record and hand back its identity, so a late result can
 *  find its own slot even after other workers have written theirs. */
export async function reserveSlot(
  sessionId: string,
  bookId: string,
  cause: WorkerCause,
  expectedGeneration: string | undefined,
  database: Pick<typeof db, "transaction"> = db,
): Promise<WorkerOutput | null> {
  return database.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT run_memories FROM play_sessions WHERE id = ${sessionId} FOR UPDATE`,
    );
    if (locked.rows.length === 0) return null;
    const current = ((locked.rows[0] as { run_memories: RunMemories | null }).run_memories ?? {}) as RunMemories;
    // Loading the worker's context may have overlapped a rewind. Check under
    // the write lock so an old job cannot create a fresh slot after the reset.
    if (current.generation !== expectedGeneration) return null;
    const workers = current.workers ?? [];
    const index = workers.filter((o) => o.bookId === bookId).length + 1;
    const slot: WorkerOutput = {
      bookId,
      index,
      at: new Date().toISOString(),
      status: "pending",
      cause: causeText(cause),
      generation: expectedGeneration,
    };
    await tx
      .update(playSessions)
      .set({ runMemories: { ...current, workers: [...workers, slot] } as unknown as Record<string, unknown> })
      .where(eq(playSessions.id, sessionId));
    return slot;
  });
}

export async function finishSlot(
  sessionId: string,
  slot: WorkerOutput,
  text: string | null,
  database: Pick<typeof db, "transaction"> = db,
): Promise<void> {
  await database.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT run_memories FROM play_sessions WHERE id = ${sessionId} FOR UPDATE`,
    );
    if (locked.rows.length === 0) return;
    const current = ((locked.rows[0] as { run_memories: RunMemories | null }).run_memories ?? {}) as RunMemories;
    if (current.generation !== slot.generation) return;
    const workers = current.workers ?? [];
    const idx = workers.findIndex((o) => o.bookId === slot.bookId && o.index === slot.index && o.at === slot.at && o.generation === slot.generation);
    // Gone means the session was reverted past this worker's run while it was
    // thinking. Its answer describes a future that no longer happened.
    if (idx === -1) return;
    const next = [...workers];
    next[idx] = text
      ? { ...next[idx]!, status: "ready", text }
      : { ...next[idx]!, status: "failed" };
    await tx
      .update(playSessions)
      .set({ runMemories: { ...current, workers: next } as unknown as Record<string, unknown> })
      .where(eq(playSessions.id, sessionId));
  });
}

/** Only the rows a transcript input actually reaches — a worker that reads no
 *  transcript costs no query at all. */
export async function loadRowsForInputs(
  sessionId: string,
  book: Worldbook,
  books: Worldbook[] | undefined,
  memories: RunMemories | null,
  database: Pick<typeof db, "select"> = db,
  cutoffAt: string = new Date().toISOString(),
): Promise<FoldableRow[]> {
  const limits = new Map<string, number>();
  for (const input of resolveInputs(book, books)) {
    if (input.kind !== "transcript") continue;
    // Several wires can read one source as different kinds of context. Load
    // its largest requested tail once; each block applies its own limit.
    const limit = Math.min(MODULE_TRANSCRIPT_MAX, input.limit);
    if (!Number.isInteger(limit) || limit < 1) continue;
    limits.set(input.from, Math.max(limits.get(input.from) ?? 0, limit));
  }
  const cutoff = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoff)) return [];
  const batches = await Promise.all([...limits].map(async ([sourceId, limit]) => {
    // The card itself: the conversation's tail, up to the moment it was
    // asked. Failed replies never happened, as in the player's own history.
    if (sourceId === "core") {
      return database
        .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(and(
          eq(messages.sessionId, sessionId),
          lte(messages.createdAt, new Date(cutoff)),
          ne(messages.status, "failed"),
          or(eq(messages.role, "user"), eq(messages.role, "assistant")),
        ))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit);
    }
    const open = memories?.open?.[sourceId];
    const spans = [
      ...(memories?.closed ?? []).filter((r) => r.bookId === sourceId)
        .map((r) => [Date.parse(r.fromAt), Date.parse(r.toAt)] as const),
      ...(open ? [[Date.parse(open.fromAt), cutoff] as const] : []),
    ].map(([from, to]) => [from, Math.min(to, cutoff)] as const)
      .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && from <= to);
    if (spans.length === 0) return [];

    // Filter to this source BEFORE limiting. A global session tail either
    // returns the first attempt forever or lets another module crowd out the
    // source this worker was actually wired to read.
    return database
      .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), or(...spans.map(([from, to]) =>
        and(gte(messages.createdAt, new Date(from)), lte(messages.createdAt, new Date(to))),
      ))))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);
  }));
  // Overlapping modules can own the same message. Keep it once, in transcript
  // order, so the downstream per-source span filter sees an ordinary history.
  const rows = [...new Map(batches.flat().map((row) => [row.id, row])).values()];
  rows.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  return rows;
}

/** The worker's own entries are its character; the creator's task is the job. */
function buildWorkerPrompt(args: {
  worldName: string | null | undefined;
  book: Worldbook;
  persona: string;
  task: string;
  context: string;
  languageInstruction: string;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        `You are a background module of an interactive-fiction card. You never address the player.`,
        `Your output is written into ANOTHER module's context, so write only what that module should know.`,
        args.persona ? `Who you are:\n${args.persona}` : "",
        `Your task: ${args.task}`,
        "Write plain prose. No headings, no lists, no JSON, no meta-commentary about being an AI.",
        "Do not invent events that are not in the material below.",
        args.languageInstruction,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "user",
      content: `World: ${args.worldName ?? "(unnamed)"}\nModule: ${args.book.name}\n\nMaterial you may use:\n${args.context || "(nothing yet)"}`,
    },
  ];
}

async function runWorkerNow(args: {
  sessionId: string;
  userId: string;
  worldName: string | null | undefined;
  worldDef: WorldDefinition;
  book: Worldbook;
  state: GameState;
  cause: WorkerCause;
  expectedGeneration: string | undefined;
}): Promise<void> {
  const station = resolveStation(args.book);
  if (station?.kind !== "worker") return;
  const task = (station.task ?? "").trim();
  // A worker with no task has nothing to be. Silence beats a generic summary
  // the creator never asked for.
  if (!task) return;

  const [session] = await db
    .select({
      summaryModel: playSessions.summaryModel,
      summaryLanguage: playSessions.summaryLanguage,
      runMemories: playSessions.runMemories,
    })
    .from(playSessions)
    .where(eq(playSessions.id, args.sessionId))
    .limit(1);
  if (!session) return;

  const memories = (session.runMemories as RunMemories | null) ?? null;
  if (memories?.generation !== args.expectedGeneration) return;
  const books = args.worldDef.worldbooks;
  const slot = await reserveSlot(args.sessionId, args.book.id, args.cause, args.expectedGeneration);
  if (!slot) return;

  try {
    const rows = await loadRowsForInputs(args.sessionId, args.book, books, memories, db, slot.at);

    const context = buildInputBlocksFor(args.book, {
      worldbooks: books,
      activeBookIds: computeActiveWorldbookIds(books, args.state),
      memories,
      alreadyInHistory: new Set<RunRecord>(),
      rows,
      variables: args.worldDef.variables,
      state: args.state,
    })
      .map((b) => b.content)
      .join("\n\n");
    const material = context;

    const persona = (args.worldDef.entries ?? [])
      .filter((e) => e.worldbookId === args.book.id && e.enabled !== false && e.role !== "greeting")
      .map((e) => e.content)
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 8000);

    const model = applyModelRedirect(
      (station.model || session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim(),
    );
    const language = normalizeSessionSummaryLanguage(session.summaryLanguage);

    // Once the slot exists it MUST be resolved. A worker that throws — a model
    // that returns nothing, a provider that refuses — used to leave its record
    // pending forever, which reads downstream as "still writing" and gives the
    // creator nothing to act on. Failed is a worse answer than a briefing and a
    // far better one than a spinner.
    const text = await generateStorySummaryText({
      userId: args.userId,
      sessionId: args.sessionId,
      model,
      prompt: buildWorkerPrompt({
        worldName: args.worldName,
        book: args.book,
        persona,
        task,
        context: material,
        languageInstruction: buildSummaryLanguageInstruction(language, { keepEnglishHeadings: false }),
      }),
      endpoint: "module-worker",
      maxTokens: MAX_WORKER_TOKENS,
    });
    await finishSlot(args.sessionId, slot, text);
  } catch (err) {
    console.error(
      `[Worker] ${args.sessionId} ${args.book.id}#${slot.index} generation failed:`,
      err instanceof Error ? err.message : err,
    );
    await finishSlot(args.sessionId, slot, null);
  }
}

/** Fire-and-forget entry point — never throws into the caller's turn. */
export function scheduleWorkerRun(args: {
  sessionId: string;
  userId: string;
  worldName: string | null | undefined;
  worldDef: WorldDefinition;
  book: Worldbook;
  state: GameState;
  cause: WorkerCause;
  /** Identity of the timeline that committed the triggering transition. */
  expectedGeneration: string | undefined;
}): void {
  void runWorkerNow(args).catch((err) => {
    console.error(
      `[Worker] ${args.sessionId} ${args.book.id} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
}
