import {
  activeNarrator,
  computeActiveWorldbookIds,
  isAnyModule,
  isArchivingModule,
  isRunTrackedModule,
  memoryPoolMembers,
  resolveInputs,
  resolveStation,
  type GameState,
  type ModuleContextInput,
  type Variable,
  type Worldbook,
} from "@yumina/engine";

/**
 * Run scopes — the infinite-flow wipe as an engine property.
 *
 * A worldbook marked `runScoped` (副本模式) treats each activation span as one
 * RUN: a dungeon attempt. While the run is open its messages are ordinary
 * history. The moment the module deactivates the run CLOSES, and on every
 * later prompt the run's messages are FOLDED — dropped from the AI's context
 * and replaced by one summary block — while the player's transcript keeps
 * every word. 《在逃命》 hand-built this with a 1,400-line frontend fallback
 * chain (revert → delete → restart); this module is that card's pattern,
 * made structural.
 *
 * Design constraints that shaped this file:
 * - Boundaries are TIMESTAMPS, not message ids or per-row tags. The history
 *   query stays narrow (no snapshot detoast per row — the 2026-08-11 lesson),
 *   and a boundary survives the rows around it being edited or swiped.
 * - Everything here degrades CONSERVATIVELY: a missed transition, a reverted
 *   session, a module whose runScoped flag was just turned off — all fall
 *   back to "don't fold", never to "fold the wrong thing". A wipe that eats
 *   live context is a catastrophe; a wipe that arrives one attempt late is
 *   a shrug.
 * - Records live in `play_sessions.run_memories`, NOT in game state: an async
 *   summary job must be able to write its result without racing the next
 *   turn's whole-state save.
 */

export interface RunRecord {
  /** Timeline that scheduled this summary; a rewind invalidates old jobs. */
  generation?: string;
  bookId: string;
  /** 1-based attempt number for this module within the session. */
  runIndex: number;
  /** createdAt of the first message of the run (ISO). Messages with
   *  fromAt <= createdAt <= toAt belong to the run. */
  fromAt: string;
  /** Boundary of the run's last message (ISO). */
  toAt: string;
  closedAt: string;
  summary?: string;
  summaryStatus: "pending" | "ready" | "failed";
  /** Restored snapshots have raw history but no trustworthy derived summary. */
  preserveTranscript?: boolean;
}

export interface RunMemories {
  /** Changed only when history is replaced, not on ordinary turns. */
  generation?: string;
  /** Currently-open runs: module id → span start. */
  open?: Record<string, { fromAt: string; runIndex: number }>;
  closed?: RunRecord[];
  /** Worker station outputs. They live here rather than in game state for the
   *  same reason run records do: the job that writes them finishes after the
   *  turn that triggered them, and a whole-state save would erase the result. */
  workers?: WorkerOutput[];
}

/** One run of a worker station — the chronicler's write-up of a dungeon, the
 *  analyst's briefing. Text, plus enough identity to attach a late result. */
export interface WorkerOutput {
  generation?: string;
  bookId: string;
  /** 1-based, per module. */
  index: number;
  /** ISO — when the trigger fired. */
  at: string;
  text?: string;
  status: "pending" | "ready" | "failed";
  /** What set it off, kept for the creator staring at an empty briefing. */
  cause?: string;
}

export interface RunTransitions {
  opened: string[];
  closed: string[];
}

const toMs = (value: string | Date | null | undefined): number => {
  if (!value) return NaN;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
};

/** The runScoped books whose active state flipped between two states. */
export function detectRunTransitions(
  worldbooks: Worldbook[] | undefined,
  prevState: GameState,
  nextState: GameState,
): RunTransitions {
  // Tracked, not merely archiving: a module that keeps its own memory needs
  // its span recorded for the opposite reason an archiving one does.
  const scoped = (worldbooks ?? []).filter(isRunTrackedModule);
  if (scoped.length === 0) return { opened: [], closed: [] };
  const prevActive = computeActiveWorldbookIds(worldbooks, prevState);
  const nextActive = computeActiveWorldbookIds(worldbooks, nextState);
  const opened: string[] = [];
  const closed: string[] = [];
  for (const wb of scoped) {
    const was = prevActive.has(wb.id);
    const is = nextActive.has(wb.id);
    if (!was && is) opened.push(wb.id);
    if (was && !is) closed.push(wb.id);
  }
  return { opened, closed };
}

/**
 * Fold the transitions into the memory record.
 *
 * `boundaryAt` is the timestamp of the message (or state patch) that carried
 * the transition: an OPENED run starts there; a CLOSED run's span ends there.
 * A close with no matching open marker is untracked — the module was already
 * active when runScoped went on, or an earlier transition was missed — and
 * folds nothing (the conservative degrade).
 */
export function applyRunTransitions(
  memories: RunMemories | null | undefined,
  transitions: RunTransitions,
  boundaryAt: string,
): { memories: RunMemories; closedRecords: RunRecord[] } {
  const open = { ...(memories?.open ?? {}) };
  const closed = [...(memories?.closed ?? [])];
  const closedRecords: RunRecord[] = [];

  for (const bookId of transitions.closed) {
    const marker = open[bookId];
    delete open[bookId];
    if (!marker) continue;
    if (!(toMs(marker.fromAt) <= toMs(boundaryAt))) continue; // clock nonsense → drop
    const record: RunRecord = {
      ...(memories?.generation ? { generation: memories.generation } : {}),
      bookId,
      runIndex: marker.runIndex,
      fromAt: marker.fromAt,
      toAt: boundaryAt,
      closedAt: boundaryAt,
      summaryStatus: "pending",
    };
    closed.push(record);
    closedRecords.push(record);
  }

  for (const bookId of transitions.opened) {
    // Re-opening over a stale marker replaces it: the abandoned span is
    // untrackable (we never saw its close), so it is forgotten, not folded.
    const runIndex = Math.max(0, ...closed.filter((r) => r.bookId === bookId).map((r) => r.runIndex)) + 1;
    open[bookId] = { fromAt: boundaryAt, runIndex };
  }

  const { open: _oldOpen, closed: _oldClosed, ...otherMemories } = memories ?? {};
  return {
    memories: {
      ...otherMemories,
      ...(Object.keys(open).length > 0 ? { open } : {}),
      ...(closed.length > 0 ? { closed } : {}),
    },
    closedRecords,
  };
}

/** Seed already-active modules on creation, or repair a legacy/untracked
 * narrator at the current input. Never widen a recorded pool's history. */
export function ensureActiveRunMemories(
  memories: RunMemories | null | undefined,
  worldbooks: Worldbook[] | undefined,
  state: GameState,
  boundaryAt: string,
): RunMemories {
  const current = memories ?? {};
  if (!Number.isFinite(toMs(boundaryAt))) return current;
  const active = computeActiveWorldbookIds(worldbooks, state);
  const missing = (worldbooks ?? []).filter((book) =>
    isRunTrackedModule(book) && active.has(book.id) && !current.open?.[book.id],
  ).map((book) => book.id);
  return missing.length ? applyRunTransitions(current, { opened: missing, closed: [] }, boundaryAt).memories : current;
}

/** The mirror of ensureActiveRunMemories.
 *
 * A module can stop being active BETWEEN turns — a frontend variable write,
 * not a keyword inside a turn — and then no transition is ever detected for
 * it, so its run stays open. An open run claims every later message as its
 * own, so the module's pool quietly swallows whoever narrated after it: come
 * back to that module three conversations later and it reads all three.
 *
 * Reconciling at the turn boundary closes those spans where they actually
 * ended. A module still active at the boundary, or one that vanished from the
 * card (unknown id), is left alone — the same conservative degrade as the
 * rest of this file. */
export function closeInactiveRunMemories(
  memories: RunMemories | null | undefined,
  worldbooks: Worldbook[] | undefined,
  state: GameState,
  boundaryAt: string,
): { memories: RunMemories; closedRecords: RunRecord[] } {
  const current = memories ?? {};
  if (!Number.isFinite(toMs(boundaryAt))) return { memories: current, closedRecords: [] };
  const active = computeActiveWorldbookIds(worldbooks, state);
  const known = new Set((worldbooks ?? []).map((book) => book.id));
  const stale = Object.keys(current.open ?? {}).filter((id) => known.has(id) && !active.has(id));
  return stale.length
    ? applyRunTransitions(current, { opened: [], closed: stale }, boundaryAt)
    : { memories: current, closedRecords: [] };
}

/** One committed turn: keyword-activated modules own the triggering input;
 * modules activated by the reply's effects begin at that reply. Reconcile
 * against the locked live state so a concurrent UI patch is not replayed. */
export function advanceRunMemories(
  memories: RunMemories | null | undefined,
  worldbooks: Worldbook[] | undefined,
  previousState: GameState,
  promptState: GameState,
  nextState: GameState,
  inputAt: string,
  replyAt: string,
  inputState: GameState = previousState,
): { memories: RunMemories; closedRecords: RunRecord[] } {
  // Spans have inclusive ends. A keyword belongs to the destination module;
  // closing its predecessor at that same timestamp would archive the input.
  const beforeInput = new Date(toMs(inputAt) - 1).toISOString();
  // Deactivations that happened between turns leave no transition to detect,
  // so reconcile against the boundary state before anything else runs.
  const reconciled = closeInactiveRunMemories(memories, worldbooks, previousState, beforeInput);
  const seeded = ensureActiveRunMemories(reconciled.memories, worldbooks, previousState, inputAt);
  const switches = detectRunTransitions(worldbooks, inputState, promptState);
  const exited = applyRunTransitions(seeded, { opened: [], closed: switches.closed.filter((id) => {
    const marker = seeded.open?.[id];
    return marker && toMs(marker.fromAt) <= toMs(beforeInput);
  }) }, beforeInput);
  const entered = applyRunTransitions(exited.memories, {
    opened: switches.opened.filter((id) => !exited.memories.open?.[id]), closed: [],
  }, inputAt);
  const effects = detectRunTransitions(worldbooks, promptState, nextState);
  const completed = applyRunTransitions(entered.memories, {
    ...effects, opened: effects.opened.filter((id) => !entered.memories.open?.[id]),
  }, replyAt);
  return {
    memories: ensureActiveRunMemories(completed.memories, worldbooks, nextState, replyAt),
    closedRecords: [...reconciled.closedRecords, ...exited.closedRecords, ...completed.closedRecords],
  };
}

/** Restore only memories valid at the surviving history boundary. Pending
 * jobs belong to the abandoned timeline. A cut archive becomes a live span,
 * not a summary of events that no longer happened. Pass null for a restart. */
export function restoreRunMemories(
  memories: RunMemories | null | undefined,
  worldbooks: Worldbook[] | undefined,
  state: GameState,
  boundaryAt: string,
  generation: string,
): RunMemories {
  const cutoff = toMs(boundaryAt);
  const active = computeActiveWorldbookIds(worldbooks, state);
  const known = new Set((worldbooks ?? []).map((book) => book.id));
  const open: NonNullable<RunMemories["open"]> = {};
  const closed: RunRecord[] = [];
  for (const record of memories?.closed ?? []) {
    if (!known.has(record.bookId) || !(toMs(record.fromAt) <= cutoff)) continue;
    if (toMs(record.toAt) > cutoff || (active.has(record.bookId) && toMs(record.toAt) === cutoff)) {
      if (active.has(record.bookId)) open[record.bookId] = { fromAt: record.fromAt, runIndex: record.runIndex };
    } else {
      closed.push(record.summaryStatus === "pending"
        ? { ...record, summary: undefined, summaryStatus: "failed", preserveTranscript: true }
        : { ...record });
    }
  }
  for (const [id, marker] of Object.entries(memories?.open ?? {})) {
    if (known.has(id) && active.has(id) && toMs(marker.fromAt) <= cutoff) open[id] = { ...marker };
  }
  return ensureActiveRunMemories({
    generation, open, closed,
    workers: (memories?.workers ?? []).filter((output) => output.status === "ready" && toMs(output.at) <= cutoff).map((output) => ({ ...output })),
  }, worldbooks, state, boundaryAt);
}

/** Checkpoints store message snapshots, not asynchronous module results.
 * Rebuild membership spans from those snapshots; keep raw text until a real
 * new archive is produced. Never borrow results from the replaced timeline. */
export function rebuildRunMemories(
  worldbooks: Worldbook[] | undefined,
  rows: Array<{ createdAt?: Date | string | null; stateSnapshot?: unknown; role?: string }>,
  initialState: GameState,
  finalState: GameState,
  generation: string,
  boundaryAt: string,
): RunMemories {
  const ordered = rows.filter((row) => Number.isFinite(toMs(row.createdAt))).slice()
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  let state = initialState;
  let hasKnownState = false;
  let memories: RunMemories = { generation };
  let lastSnapshotAt: string | undefined;
  for (const row of ordered) {
    const at = new Date(toMs(row.createdAt)).toISOString();
    if (!row.stateSnapshot || typeof row.stateSnapshot !== "object" || !("variables" in row.stateSnapshot)) continue;
    const next = row.stateSnapshot as GameState;
    if (!hasKnownState) {
      // Pruned snapshots leave ownership unknown. Starting the default module
      // at the first row would assign another module's private history to it.
      memories = ensureActiveRunMemories(memories, worldbooks, next, at);
      state = next;
      hasKnownState = true;
      lastSnapshotAt = at;
      continue;
    }
    const transitions = detectRunTransitions(worldbooks, state, next);
    // A post-reply snapshot cannot prove whether the module changed on the
    // player's input, a UI action, or the reply's effects. Do not give that
    // unknown interval to either private pool. Retain the predecessor through
    // its last proven snapshot and start the destination at its first one.
    memories = applyRunTransitions(memories, { opened: [], closed: transitions.closed }, lastSnapshotAt ?? at).memories;
    memories = applyRunTransitions(memories, { opened: transitions.opened, closed: [] }, at).memories;
    state = next;
    lastSnapshotAt = at;
  }
  const transitions = hasKnownState ? detectRunTransitions(worldbooks, state, finalState) : { opened: [], closed: [] };
  memories = applyRunTransitions(memories, { opened: [], closed: transitions.closed }, lastSnapshotAt ?? boundaryAt).memories;
  memories = applyRunTransitions(memories, { opened: transitions.opened, closed: [] }, boundaryAt).memories;
  return ensureActiveRunMemories({
    ...memories,
    closed: (memories.closed ?? []).map((record) => ({ ...record, summaryStatus: "failed", preserveTranscript: true })),
  }, worldbooks, finalState, boundaryAt);
}

/** A transcript edit invalidates derived text from that point onward, while
 * keeping membership spans so private pools still see the surviving text. */
export function invalidateRunMemoryText(memories: RunMemories | null | undefined, fromAt: string, generation: string): RunMemories {
  const cutoff = toMs(fromAt);
  return {
    ...memories, generation,
    open: memories?.open ? Object.fromEntries(Object.entries(memories.open).map(([id, marker]) => [id, { ...marker }])) : undefined,
    closed: (memories?.closed ?? []).map((record) => toMs(record.toAt) >= cutoff || record.summaryStatus === "pending"
      ? { ...record, summary: undefined, summaryStatus: "failed", preserveTranscript: true } : { ...record }),
    workers: (memories?.workers ?? []).filter((output) => output.status === "ready" && toMs(output.at) < cutoff).map((output) => ({ ...output })),
  };
}

export interface FoldableRow {
  role: string;
  content: string;
  createdAt: Date | string | null;
}

export interface FoldResult<T extends FoldableRow> {
  rows: Array<T | { role: "system"; content: string; createdAt: Date | string | null; __runFold: true }>;
  foldedMessageCount: number;
  foldedRunCount: number;
  /** Records whose memory block was emitted in-place — a subscription must
   *  not inject the same run a second time. */
  emittedRecords: ReadonlySet<RunRecord>;
}

const RUN_MEMORY_PENDING_TEXT =
  "（这次攻略的详细经过已封存，记忆正在整理中——只保留结算与状态变化。）";
const RUN_MEMORY_FAILED_TEXT =
  "（这次攻略的详细经过已封存。）";

export function formatRunMemoryBlock(record: RunRecord, moduleName: string): string {
  const body =
    record.summaryStatus === "ready" && record.summary
      ? record.summary
      : record.summaryStatus === "failed"
        ? RUN_MEMORY_FAILED_TEXT
        : RUN_MEMORY_PENDING_TEXT;
  return `【副本记忆 · ${moduleName} · 第${record.runIndex}次】\n${body}`;
}

/**
 * Replace every CLOSED run's messages with its single memory block.
 *
 * Guards, in order:
 * - only records whose module still exists AND is still runScoped fold;
 * - revert guard: if the record's module is ACTIVE again and the record's
 *   span reaches the newest row, the session was reverted back INSIDE that
 *   very span — its messages are the live present, and a "memory" of a
 *   future that no longer happened must not shadow them. (A close that came
 *   through a state PATCH has toAt minutes past the last message — the
 *   module is inactive then, so a plain "span must end before the newest
 *   row" check would wrongly veto every frontend-closed run.)
 * - rows are matched purely by timestamp within [fromAt, toAt]; a record
 *   whose span matches no rows folds nothing and injects nothing.
 */
export function foldClosedRuns<T extends FoldableRow>(
  rows: T[],
  memories: RunMemories | null | undefined,
  worldbooks: Worldbook[] | undefined,
  currentlyActiveBookIds: ReadonlySet<string>,
): FoldResult<T> {
  const records = memories?.closed ?? [];
  if (records.length === 0 || rows.length === 0) {
    return { rows, foldedMessageCount: 0, foldedRunCount: 0, emittedRecords: new Set() };
  }
  const byId = new Map((worldbooks ?? []).map((wb) => [wb.id, wb]));
  const newestMs = rows.reduce((max, r) => Math.max(max, toMs(r.createdAt) || 0), 0);

  const applicable = records
    .map((record) => ({ record, book: byId.get(record.bookId) }))
    .filter(({ record, book }) => {
      if (!isArchivingModule(book) || record.preserveTranscript) return false;
      const from = toMs(record.fromAt);
      const to = toMs(record.toAt);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return false;
      if (currentlyActiveBookIds.has(record.bookId) && to >= newestMs) return false;
      return true;
    });
  if (applicable.length === 0) return { rows, foldedMessageCount: 0, foldedRunCount: 0, emittedRecords: new Set() };

  const out: FoldResult<T>["rows"] = [];
  let foldedMessageCount = 0;
  const emitted = new Set<RunRecord>();

  for (const row of rows) {
    const ms = toMs(row.createdAt);
    const hit = Number.isFinite(ms)
      ? applicable.find(({ record }) => toMs(record.fromAt) <= ms && ms <= toMs(record.toAt))
      : undefined;
    if (!hit) {
      out.push(row);
      continue;
    }
    foldedMessageCount++;
    if (!emitted.has(hit.record)) {
      emitted.add(hit.record);
      out.push({
        role: "system",
        content: formatRunMemoryBlock(hit.record, hit.book!.name),
        createdAt: row.createdAt,
        __runFold: true,
      });
    }
  }

  return { rows: out, foldedMessageCount, foldedRunCount: emitted.size, emittedRecords: emitted };
}

/**
 * The rows a module with its OWN memory is allowed to see: everything spoken
 * inside its runs — closed ones and the one open now — and nothing else.
 *
 * Walking into the tower, the AI there has never heard of the town. That is
 * the whole feature, and it is a view: the transcript keeps every word, the
 * player's scrollback keeps every word, and every other module keeps seeing
 * them. Only this module's window is narrow.
 *
 * A module whose span was never recorded (active before it was made
 * run-tracked) has no window to narrow to. It sees nothing — the honest
 * reading of "own memory" for a module with no recorded run, and the same
 * thing a brand-new run sees on its first turn.
 */
export function scopeRowsToOwnRuns<T extends FoldableRow>(
  rows: T[],
  memories: RunMemories | null | undefined,
  bookId: string,
): T[] {
  return scopeRowsToRuns(rows, memories, [bookId]);
}

/**
 * The rows spoken inside the runs of ANY of the modules named — closed runs
 * and open ones. A memory pool is exactly this: "A and B share one memory"
 * means inside A the AI has A's runs and B's, and nothing from outside them.
 */
export function scopeRowsToRuns<T extends FoldableRow>(
  rows: T[],
  memories: RunMemories | null | undefined,
  bookIds: readonly string[],
): T[] {
  const ids = new Set(bookIds);
  const spans: Array<{ from: number; to: number }> = [];
  for (const r of memories?.closed ?? []) {
    if (!ids.has(r.bookId)) continue;
    const from = toMs(r.fromAt);
    const to = toMs(r.toAt);
    if (Number.isFinite(from) && Number.isFinite(to) && from <= to) spans.push({ from, to });
  }
  for (const id of ids) {
    const open = memories?.open?.[id];
    if (!open) continue;
    const from = toMs(open.fromAt);
    if (Number.isFinite(from)) spans.push({ from, to: Number.POSITIVE_INFINITY });
  }
  if (spans.length === 0) return [];
  return rows.filter((row) => {
    const ms = toMs(row.createdAt);
    return Number.isFinite(ms) && spans.some((s) => s.from <= ms && ms <= s.to);
  });
}

/**
 * The history the prompt is built from, in one place.
 *
 * Two things narrow the transcript before it reaches the model, in this
 * order: the narrating module's memory scope (own runs only, if it says so),
 * then the archive fold (closed runs of archiving modules become one block
 * each). The three prompt paths — send, regenerate, continue — used to call
 * the fold directly and would each have needed the scope added by hand.
 */
export function promptHistory<T extends FoldableRow>(
  rows: T[],
  memories: RunMemories | null | undefined,
  worldbooks: Worldbook[] | undefined,
  currentlyActiveBookIds: ReadonlySet<string>,
): FoldResult<T> {
  const narrator = activeNarrator(worldbooks, currentlyActiveBookIds);
  const pool = narrator ? resolveStation(narrator)?.memoryPool ?? null : null;
  // A narrator in a pool sees the pool's runs — its own and every module that
  // named the same pool. The card's pool (null) is the whole transcript.
  const scoped = pool
    ? scopeRowsToRuns(rows, memories, memoryPoolMembers(worldbooks, pool).map((wb) => wb.id))
    : rows;
  return foldClosedRuns(scoped, memories, worldbooks, currentlyActiveBookIds);
}

export const DEFAULT_SUBSCRIPTION_LIMIT = 5;

/** What a station can be handed, beyond the module list and the memories:
 *  the rows of the turn being assembled (for a transcript input) and the
 *  card's variables plus current state (for a variables input). */
export interface ContextInputSources<T extends FoldableRow> {
  worldbooks: Worldbook[] | undefined;
  activeBookIds: ReadonlySet<string>;
  memories: RunMemories | null | undefined;
  /** Records whose fold block is already visible in the history — one run,
   *  one telling. */
  alreadyInHistory: ReadonlySet<RunRecord>;
  rows: T[];
  variables?: Variable[];
  state: GameState;
}

const asMode = (input: ModuleContextInput): "history" | "lore" =>
  input.as === "lore" ? "lore" : "history";

/** The spans of one module, oldest first: its closed runs plus, if it is
 *  currently mid-run, the open one running to now. */
function spansOf(
  memories: RunMemories | null | undefined,
  bookId: string,
): Array<{ from: number; to: number }> {
  const spans = (memories?.closed ?? [])
    .filter((r) => r.bookId === bookId)
    .map((r) => ({ from: toMs(r.fromAt), to: toMs(r.toAt) }));
  const open = memories?.open?.[bookId];
  if (open) spans.push({ from: toMs(open.fromAt), to: Number.POSITIVE_INFINITY });
  return spans.filter((span) => Number.isFinite(span.from));
}

function memoryBlock(
  source: Worldbook,
  input: ModuleContextInput,
  memories: RunMemories | null | undefined,
  alreadyInHistory: ReadonlySet<RunRecord>,
): string | null {
  const limit = ("limit" in input && input.limit) || DEFAULT_SUBSCRIPTION_LIMIT;
  const records = (memories?.closed ?? [])
    .filter(
      (r) =>
        r.bookId === source.id &&
        r.summaryStatus === "ready" &&
        r.summary &&
        !alreadyInHistory.has(r),
    )
    .slice(-limit);
  if (records.length === 0) return null;
  const header =
    asMode(input) === "lore"
      ? `【档案记录 · 「${source.name}」的历次经过】(可查阅的记录与传闻，并非主角亲身经历)`
      : `【过往经历 · 「${source.name}」】(主角亲历过的经过，记忆如下)`;
  return [header, ...records.map((r) => `第${r.runIndex}次: ${r.summary}`)].join("\n");
}

function workerBlock(
  source: Worldbook,
  input: ModuleContextInput,
  memories: RunMemories | null | undefined,
): string | null {
  const limit = ("limit" in input && input.limit) || DEFAULT_SUBSCRIPTION_LIMIT;
  const outputs = (memories?.workers ?? [])
    .filter((o) => o.bookId === source.id && o.status === "ready" && o.text)
    .slice(-limit);
  if (outputs.length === 0) return null;
  const header =
    asMode(input) === "lore"
      ? `【${source.name}】(一份关于你的记录，你未必读过)`
      : `【${source.name}】(你知道的事)`;
  return [header, ...outputs.map((o) => o.text)].join("\n\n");
}

/**
 * Every archiving module's finished runs, as one block.
 *
 * The head archivist's input: `from: "*"` on a card with twenty-two dungeons.
 * Interleaved by time and trimmed to `limit` across the whole set rather than
 * per module, because "the last five things that happened to me" is what the
 * reader means, not "the last five of each of twenty-two".
 */
function anyMemoryBlock(
  self: Worldbook,
  input: ModuleContextInput,
  books: Worldbook[],
  memories: RunMemories | null | undefined,
  alreadyInHistory: ReadonlySet<RunRecord>,
): string | null {
  const limit = ("limit" in input && input.limit) || DEFAULT_SUBSCRIPTION_LIMIT;
  const byId = new Map(books.map((b) => [b.id, b]));
  const records = (memories?.closed ?? [])
    .filter(
      (r) =>
        r.bookId !== self.id &&
        r.summaryStatus === "ready" &&
        r.summary &&
        byId.has(r.bookId) &&
        !alreadyInHistory.has(r),
    )
    .slice(-limit);
  if (records.length === 0) return null;
  const header =
    asMode(input) === "lore"
      ? "【档案记录 · 历次经过】(可查阅的记录与传闻，并非主角亲身经历)"
      : "【过往经历】(主角亲历过的经过，记忆如下)";
  // Each line names its module: without that the reader cannot tell one
  // dungeon's third run from another's, which is the whole point of reading
  // all of them at once.
  return [
    header,
    ...records.map((r) => `「${byId.get(r.bookId)?.name ?? r.bookId}」第${r.runIndex}次: ${r.summary}`),
  ].join("\n");
}

/** Every other worker's latest output, as one block — the archivist reading
 *  the whole archive rather than one shelf of it. */
function anyWorkerBlock(
  self: Worldbook,
  input: ModuleContextInput,
  books: Worldbook[],
  memories: RunMemories | null | undefined,
): string | null {
  const limit = ("limit" in input && input.limit) || DEFAULT_SUBSCRIPTION_LIMIT;
  const workers = new Map(
    books.filter((b) => b.id !== self.id && resolveStation(b)?.kind === "worker").map((b) => [b.id, b]),
  );
  const outputs = (memories?.workers ?? [])
    .filter((o) => workers.has(o.bookId) && o.status === "ready" && o.text)
    .slice(-limit);
  if (outputs.length === 0) return null;
  const header =
    asMode(input) === "lore"
      ? "【卷宗汇编】(各处记录的汇总，你未必读过)"
      : "【你知道的事】";
  return [
    header,
    ...outputs.map((o) => `《${workers.get(o.bookId)?.name ?? o.bookId}》: ${o.text}`),
  ].join("\n\n");
}

/** A module's variables, as the receiving AI would want them read: names and
 *  values, nothing about ids or types. `source` null = the card's own
 *  (Core) variables. */
function variablesBlock(
  source: Worldbook | null,
  sources: ContextInputSources<FoldableRow>,
): string | null {
  const wanted = (sources.variables ?? []).filter((v) =>
    source ? v.worldbookId === source.id : !v.worldbookId,
  );
  if (wanted.length === 0) return null;
  const lines = wanted.map((v) => {
    const value = sources.state.variables?.[v.id];
    const shown =
      value === undefined || value === null
        ? "—"
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    return `${v.name}: ${shown}`;
  });
  return [`【状态 · ${source ? source.name : "全局"}】`, ...lines].join("\n");
}

/** Another module's actual words. The honest input and the expensive one, so
 *  the schema caps it and this takes the tail. */
function transcriptBlock<T extends FoldableRow>(
  source: Worldbook,
  input: Extract<ModuleContextInput, { kind: "transcript" }>,
  sources: ContextInputSources<T>,
): string | null {
  const spans = spansOf(sources.memories, source.id);
  if (spans.length === 0) return null;
  const rows = sources.rows
    .filter((row) => {
      const ms = toMs(row.createdAt);
      return Number.isFinite(ms) && spans.some((span) => span.from <= ms && ms <= span.to);
    })
    .slice(-input.limit);
  if (rows.length === 0) return null;
  const header =
    asMode(input) === "lore"
      ? `【记录原文 · 「${source.name}」】(逐字记录)`
      : `【${source.name} · 经过】`;
  const body = rows.map((r) => `${r.role === "user" ? "玩家" : "叙述"}: ${r.content}`);
  return [header, ...body].join("\n");
}

/** The whole conversation's latest messages: what a recorder behind the
 *  scenes reads when it is wired to the card itself rather than to one
 *  situation's spans. */
function conversationBlock<T extends FoldableRow>(
  input: Extract<ModuleContextInput, { kind: "transcript" }>,
  sources: ContextInputSources<T>,
): string | null {
  const rows = sources.rows.slice(-input.limit);
  if (rows.length === 0) return null;
  const header = asMode(input) === "lore" ? "【对话原文】(逐字记录)" : "【最近的对话】";
  return [header, ...rows.map((r) => `${r.role === "user" ? "玩家" : "叙述"}: ${r.content}`)].join("\n");
}

/**
 * Every block the ACTIVE stations have asked for.
 *
 * One pass over the active modules in module order, then each station's inputs
 * in the order the creator arranged them — the canvas draws these as wires,
 * and a wire's place in the list is the creator saying "this one first".
 *
 * Deduplicated by (kind, source, mode): two dungeons drinking the same
 * chronicler get one briefing between them, not two copies of it.
 */
/**
 * The blocks ONE module has asked for, whether or not it is active.
 *
 * The active check belongs to the caller: a narrator only draws context while
 * it is narrating, but a worker builds its own material at the moment it is
 * triggered, which is not the same moment.
 *
 * `seen` is threaded in so several modules can be assembled into one prompt
 * without repeating a source — pass a fresh Set for a standalone build.
 */
export function buildInputBlocksFor<T extends FoldableRow>(
  wb: Worldbook,
  sources: ContextInputSources<T>,
  seen: Set<string> = new Set(),
): Array<{ role: "system"; content: string }> {
  const books = sources.worldbooks ?? [];
  if (!resolveStation(wb)) return [];
  const byId = new Map(books.map((b) => [b.id, b]));
  const blocks: Array<{ role: "system"; content: string }> = [];

  for (const input of resolveInputs(wb, books)) {
    const key = `${input.kind}|${input.from}|${asMode(input)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isAnyModule(input.from)) {
      // A role, not a module: resolveInputs has already dropped the kinds that
      // cannot answer one, so only these two arrive here.
      const many =
        input.kind === "memory"
          ? anyMemoryBlock(wb, input, books, sources.memories, sources.alreadyInHistory)
          : input.kind === "worker"
            ? anyWorkerBlock(wb, input, books, sources.memories)
            : null;
      if (many) blocks.push({ role: "system", content: many });
      continue;
    }
    const source = input.from === "core" ? null : byId.get(input.from) ?? null;
    // Core answers variables, and to an AI behind the scenes the whole
    // conversation's tail. A narrator has the conversation already, folded
    // the way its memory folds it; read raw again, it would bring back runs
    // its memory had closed.
    const coreTranscript = input.kind === "transcript" && input.from === "core";
    if (coreTranscript && resolveStation(wb)?.kind !== "worker") continue;
    if (!source && input.kind !== "variables" && !coreTranscript) continue;

    let content: string | null = null;
    if (input.kind === "memory" && source) {
      content = memoryBlock(source, input, sources.memories, sources.alreadyInHistory);
    } else if (input.kind === "worker" && source) {
      content = workerBlock(source, input, sources.memories);
    } else if (input.kind === "variables") {
      content = variablesBlock(source, sources as unknown as ContextInputSources<FoldableRow>);
    } else if (input.kind === "transcript" && source) {
      content = transcriptBlock(source, input, sources);
    } else if (input.kind === "transcript") {
      content = conversationBlock(input, sources);
    }
    if (content) blocks.push({ role: "system", content });
  }
  return blocks;
}

/**
 * The context blocks for the PLAYER-FACING turn.
 *
 * Only the narrating station's wires are drawn here. A worker's inputs are its
 * own reading material — it builds them for itself when it runs — and letting
 * them into this prompt was worse than wasteful: a chronicler wired to read a
 * dungeon's raw transcript put that transcript back into every later turn, so
 * the run the card had just archived returned verbatim and the wipe meant
 * nothing. Found by playing 《在逃命》, not by any test that existed first.
 *
 * No narrator station means no wires: that is every card today, and the
 * session's own model narrates with the prompt it always had.
 */
export function buildContextInputBlocks<T extends FoldableRow>(
  sources: ContextInputSources<T>,
): Array<{ role: "system"; content: string }> {
  const books = sources.worldbooks ?? [];
  if (books.length === 0) return [];
  const narrator = activeNarrator(books, sources.activeBookIds);
  if (!narrator) return [];
  return buildInputBlocksFor(narrator, sources);
}

/** Write a finished (or failed) summary onto its record, matched by identity
 *  (bookId + runIndex + fromAt). Returns null when the record is gone —
 *  a revert erased the run while the summary was generating. */
export function attachRunSummary(
  memories: RunMemories | null | undefined,
  target: Pick<RunRecord, "bookId" | "runIndex" | "fromAt"> & Partial<Pick<RunRecord, "generation" | "toAt">>,
  summary: string | null,
): RunMemories | null {
  if (target.generation !== memories?.generation) return null;
  const closed = memories?.closed ?? [];
  const idx = closed.findIndex(
    (r) => r.bookId === target.bookId && r.runIndex === target.runIndex && r.fromAt === target.fromAt &&
      (target.toAt === undefined || r.toAt === target.toAt),
  );
  if (idx === -1) return null;
  const next = [...closed];
  next[idx] = {
    ...next[idx]!,
    ...(summary
      ? { summary, summaryStatus: "ready" as const }
      : { summaryStatus: "failed" as const }),
  };
  return { ...(memories ?? {}), closed: next };
}
