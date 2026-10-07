import type {
  ModuleContextInput,
  ModuleStation,
  Worldbook,
} from "../types/index.js";

/**
 * 模块总控 — reading a module as an AI station.
 *
 * A card used to be one AI with a gated prompt. A station makes a module the
 * AI: its own model, its own context, its own lifecycle. Everything that
 * decides those things now lives on one field, and everything that reads it
 * goes through this file — server prompt assembly, the worker runner, the
 * canvas, and the studio agent all get the same answer.
 *
 * The legacy shapes (`runScoped`, `runSummaryPrompt`, `memorySubscriptions`)
 * are normalised here and nowhere else. They were shipped, briefly, before the
 * station model; no stored card uses them, but a card exported during that
 * window still has to open. Read once, converted, never written back.
 */

/** A station with its defaults filled in — what callers actually reason about. */
export interface ResolvedStation extends Omit<ModuleStation, "memoryPool"> {
  /** Resolved rather than optional: a station archives its span on close
   *  unless the creator says otherwise. A module IS a run. */
  onClose: "archive" | "keep";
  /** Resolved: a station remembers the shared transcript unless it says
   *  otherwise. Workers have no transcript view of their own. "own" now
   *  means "in some pool other than the card's" — see `memoryPool`. */
  history: "shared" | "own";
  /** Resolved: the pool this narrator's memory lives in, or null for the
   *  card's own. The legacy "own" flag resolves to a pool of one named after
   *  the module, so every reader can forget the flag existed. */
  memoryPool: string | null;
  inputs: ModuleContextInput[];
}

/** The pool a module keeps to itself: named after the module, so two cards'
 *  worth of readers agree on it without a lookup. */
export const ownMemoryPool = (bookId: string): string => `pool-${bookId}`;

/**
 * "Whichever one it was" — a station addressing a ROLE instead of a module.
 *
 * A card with twenty-two dungeons and a chronicler for each cannot be wired by
 * hand: one chronicler that wakes for whoever just closed is one module, and a
 * head archivist who reads all of them is one wire instead of twenty-one (the
 * schema caps a station at twelve, so the wires were not merely tedious —
 * past twelve they were impossible).
 *
 * Only where "all of them" is a bounded, cheap set: a trigger, archived
 * memories, and worker output. Never a transcript — every dungeon's raw words
 * at once is the prompt this whole model exists to avoid.
 */
export const ANY_MODULE = "*";

/** Whether this input or trigger addresses a role rather than one module. */
export const isAnyModule = (from: string | undefined): boolean => from === ANY_MODULE;

/** The input kinds that may address `*`. Transcript is deliberately absent —
 *  see ANY_MODULE — and variables already have `core` for "the card's". */
export const WILDCARD_INPUT_KINDS: ReadonlySet<string> = new Set(["memory", "worker"]);

/**
 * The station this module is, or null if it is a plain content module.
 *
 * Plain is the default and the back-compat guarantee: a module with no station
 * contributes its entries and variables to whoever is narrating, exactly as
 * modules have always done, and takes part in none of this.
 */
export function resolveStation(wb: Worldbook | undefined | null): ResolvedStation | null {
  if (!wb) return null;

  if (wb.station && (wb.station.kind === "narrator" || wb.station.kind === "worker")) {
    const pool =
      wb.station.kind !== "narrator"
        ? null
        : typeof wb.station.memoryPool === "string" && wb.station.memoryPool
          ? wb.station.memoryPool
          : wb.station.history === "own"
            ? ownMemoryPool(wb.id)
            : null;
    return {
      ...wb.station,
      // A worker has no span of player messages to archive, so the question
      // does not apply to it; answering "keep" keeps the fold logic honest.
      onClose:
        wb.station.kind === "worker" ? "keep" : (wb.station.onClose ?? "archive"),
      history: pool ? "own" : "shared",
      memoryPool: pool,
      inputs: Array.isArray(wb.station.inputs) ? wb.station.inputs : [],
    };
  }

  const legacyInputs: ModuleContextInput[] = Array.isArray(wb.memorySubscriptions)
    ? wb.memorySubscriptions
        .filter((sub) => sub && typeof sub.sourceBookId === "string" && sub.sourceBookId)
        .map((sub) => ({
          kind: "memory" as const,
          from: sub.sourceBookId,
          ...(sub.as ? { as: sub.as } : {}),
          ...(typeof sub.limit === "number" ? { limit: sub.limit } : {}),
        }))
    : [];

  if (!wb.runScoped && legacyInputs.length === 0) return null;

  return {
    kind: "narrator",
    onClose: wb.runScoped ? "archive" : "keep",
    history: "shared",
    memoryPool: null,
    ...(wb.runSummaryPrompt ? { archivePrompt: wb.runSummaryPrompt } : {}),
    inputs: legacyInputs,
  };
}

/**
 * Every narrator whose memory lives in `pool`, in a stable order. The card's
 * own pool (null) is not a list — it is everyone, which is what "no pool"
 * means to the prompt — so it answers empty.
 */
export function memoryPoolMembers(worldbooks: Worldbook[] | undefined, pool: string | null): Worldbook[] {
  if (!pool || !Array.isArray(worldbooks)) return [];
  return worldbooks
    .filter((wb) => resolveStation(wb)?.memoryPool === pool)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

/** Whether this module's activation span is archived when it closes — the
 *  infinite-flow wipe. Replaces the old `wb.runScoped` predicate. */
export function isArchivingModule(wb: Worldbook | undefined | null): boolean {
  const station = resolveStation(wb);
  return station?.kind === "narrator" && station.onClose === "archive";
}

/**
 * Whether this module's activation spans are recorded as runs at all.
 *
 * Archiving needs the span to know what to fold. A module in a memory pool
 * needs it for the opposite reason: to know which messages are the pool's to
 * keep. Both are run boundaries; only the first replaces anything.
 */
export function isRunTrackedModule(wb: Worldbook | undefined | null): boolean {
  const station = resolveStation(wb);
  return station?.kind === "narrator" && (station.onClose === "archive" || station.memoryPool !== null);
}

/** Who answers the player right now: the room, and its voices in order. */
export interface ReplyRoom {
  /** "card", or the id of the situation whose AIs are answering. */
  id: string;
  /** In speaking order. `null` is the card's own narrator. */
  members: Array<Worldbook | null>;
}

const byOrder = (a: Worldbook, b: Worldbook) =>
  (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);

/**
 * The room the player is talking into, and every AI in it that answers.
 *
 * A situation that is on and has AIs of its own is the room: its own station
 * (the older shape, a situation that IS its AI) and the AIs that live in it,
 * plus the card's narrator when the situation keeps it. Two such situations
 * on at once: the first by `order` is the room. Otherwise the card is the
 * room: its narrator, then the AIs that live on the card. One voice is a
 * conversation; several are a group chat, answering one after another.
 *
 * Ties break by `order` then id so the answer is deterministic — the same
 * turn replayed after a revert must reach the same voices.
 */
export function replyRoom(
  worldbooks: Worldbook[] | undefined,
  activeIds: ReadonlySet<string>,
): ReplyRoom {
  const books = Array.isArray(worldbooks) ? worldbooks : [];
  const voices = books.filter((wb) => activeIds.has(wb.id) && resolveStation(wb)?.kind === "narrator");
  const livingIn = (place: string) => voices.filter((wb) => wb.host === place).sort(byOrder);
  const place = books
    .filter((wb) => wb.host === undefined && activeIds.has(wb.id))
    .filter((wb) => resolveStation(wb)?.kind === "narrator" || livingIn(wb.id).length > 0)
    .sort(byOrder)[0];
  if (place) {
    const own = resolveStation(place)?.kind === "narrator" ? [place] : [];
    return { id: place.id, members: [...(place.narratorHere ? [null] : []), ...own, ...livingIn(place.id)] };
  }
  return { id: "card", members: [null, ...livingIn("card")] };
}

/**
 * Which station gives the reply to the player's message: the room's first
 * voice. The rest of the room answers after it (`replyRoom`).
 *
 * Null means the card's own narrator, which is every card that has never heard
 * of stations: the session's own model narrates with the whole active prompt,
 * exactly as before.
 */
export function activeNarrator(
  worldbooks: Worldbook[] | undefined,
  activeIds: ReadonlySet<string>,
): Worldbook | null {
  if (!Array.isArray(worldbooks)) return null;
  return replyRoom(worldbooks, activeIds).members[0] ?? null;
}

/** The voices that answer after the first one, in order — a group chat's
 *  second and later replies. Empty in a room of one. */
export function followingVoices(
  worldbooks: Worldbook[] | undefined,
  activeIds: ReadonlySet<string>,
): Worldbook[] {
  return replyRoom(worldbooks, activeIds).members.slice(1).filter((m): m is Worldbook => m !== null);
}

/** Every worker station on the card, in a stable order. */
export function workerModules(worldbooks: Worldbook[] | undefined): Worldbook[] {
  if (!Array.isArray(worldbooks)) return [];
  return worldbooks
    .filter((wb) => wb.enabled !== false && resolveStation(wb)?.kind === "worker")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

/**
 * The inputs a station actually draws, with dead wiring dropped.
 *
 * Silent skips rather than errors, and for the same reason module membership
 * fails open: a card whose chronicler was deleted should lose the briefing,
 * not the session. Self-reference is dropped too — a module drinking its own
 * memories is a loop the creator cannot see.
 */
export function resolveInputs(
  wb: Worldbook,
  worldbooks: Worldbook[] | undefined,
): ModuleContextInput[] {
  const station = resolveStation(wb);
  if (!station) return [];
  const known = new Set((worldbooks ?? []).map((b) => b.id));
  return station.inputs.filter((input) => {
    if (input.from === wb.id) return false;
    // A role reference resolves at read time, not here: which modules answer
    // to it is a question for the moment the block is built.
    if (isAnyModule(input.from)) return WILDCARD_INPUT_KINDS.has(input.kind);
    return known.has(input.from) || input.from === "core";
  });
}
