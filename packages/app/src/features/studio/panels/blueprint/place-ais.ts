import { ANY_MODULE, extractAiCallsFromFiles, memoryPoolMembers, resolveStation, type FrontendAiCall, type ModuleStation, type WorldDefinition, type Worldbook } from "@yumina/engine";
import { stationName, voiceOf, workerReaders } from "./ai-roster";
import type { AiType } from "./add-ai";

/** Which of the three an AI is, by what calls it: the player's turn (it
 *  answers, or works right after an answer / every few turns), the player's
 *  screen (a button), or the card's logic (a value, a scenario ending, a
 *  silence). */
export function aiTypeOf(station: Pick<ModuleStation, "kind" | "trigger"> | null | undefined): AiType {
  if (station?.kind === "custom") return "custom";
  if (!station || station.kind === "narrator") return "turn";
  const on = station.trigger?.on;
  if (on === "turns" || on === "after") return "turn";
  if (on === "ui") return "ui";
  return "code";
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 「这里的 AI」: who answers in a frame, said in the creator's terms.
 *
 * An AI lives somewhere — on the card, or in a situation — and is in play
 * when that place is. The card's own AI is its narrator; the AIs that live on
 * the card answer after it, one after another. In a situation with AIs of its
 * own, those AIs answer instead of the narrator, unless the situation keeps
 * it. Two voices or more in one place is a group chat.
 *
 * Each row says what the AI does and what it remembers or hands on: memory is
 * the reason there are several AIs at all, so it is on the row, not behind a
 * click.
 */
export interface PlaceAiRow {
  /** "narrator", or the AI's worldbook id. */
  key: string;
  /** Set for an AI with settings of its own. */
  bookId?: string;
  name: string;
  /** Turn-based, UI-based or code-based. */
  type: AiType;
  /** Not in play: put nowhere (stored before every AI had to live somewhere). */
  off?: boolean;
  /** What it does: 回复玩家, 冷场时主动说话, 幕后 · 每 3 回合. */
  job: string;
  /** What it remembers. */
  memory: string;
  /** What passes between it and the other AIs: 收到 X 写的 / 写给 X. */
  link?: string;
  /** The card's narrator, in a situation whose own AIs answer instead. */
  away?: boolean;
  /** An AI call the interface code makes itself — no settings of its own;
   *  the row says what the scan read off the call and opens the file. */
  code?: FrontendAiCall;
}

export interface PlaceAis {
  rows: PlaceAiRow[];
  /** Two or more voices answer the player here, one after another. */
  group: boolean;
  /** A situation with AIs of its own, where the narrator can be kept. */
  canKeepNarrator: boolean;
  keepsNarrator: boolean;
}

const byOrder = (a: Worldbook, b: Worldbook) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
const join = (t: Translate, names: string[]) =>
  names.slice(0, 3).join(String(t("blueprint.ctx.flowJoin"))) + (names.length > 3 ? ` +${names.length - 3}` : "");

/** The AIs that live in a place ("card" or a situation's id), in speaking order. */
export function aisLivingIn(books: readonly Worldbook[], place: string): Worldbook[] {
  return books.filter((b) => b.host === place && !!b.station).sort(byOrder);
}

/** Every AI is a row of a place's 「AI」 block, never a frame: one that lives
 *  on the card or in a scenario, one stored before that (put nowhere, or a
 *  behind-the-scenes situation of its own — drawn on the card). A scenario
 *  that runs its own AI stays a scenario. */
export function livesSomewhere(book: Pick<Worldbook, "host" | "station">): boolean {
  if (!book.station) return false;
  return book.host !== undefined || book.station.kind === "worker";
}

function memoryOf(book: Worldbook, books: readonly Worldbook[], t: Translate): string {
  const station = resolveStation(book);
  if (!station) return "";
  if (station.kind === "worker") {
    const transcript = station.inputs.find((i) => i.kind === "transcript");
    if (station.trigger?.on === "quiet") return String(t("blueprint.placeAis.memReads", { n: 12 }));
    if (transcript) return String(t("blueprint.placeAis.memReads", { n: transcript.limit ?? 20 }));
    return String(t("blueprint.placeAis.memNothing"));
  }
  const limit = station.historyLimit;
  const recent = limit ? ` · ${t("blueprint.placeAis.memRecent", { n: limit })}` : "";
  if (station.memoryPool === null) return String(t("blueprint.placeAis.memAll")) + recent;
  const mates = memoryPoolMembers([...books], station.memoryPool).filter((b) => b.id !== book.id).map((b) => b.name);
  if (mates.length) return String(t("blueprint.placeAis.memPool", { names: join(t, mates) })) + recent;
  return String(t(station.onClose === "archive" ? "blueprint.placeAis.memOwnArchive" : "blueprint.placeAis.memOwn")) + recent;
}

function linkOf(book: Worldbook, books: readonly Worldbook[], t: Translate): string | undefined {
  const station = resolveStation(book);
  if (!station) return undefined;
  if (station.kind === "worker") {
    if (station.trigger?.on === "quiet") return undefined;
    const readers = workerReaders([...books], book.id).map(stationName);
    return String(readers.length ? t("blueprint.placeAis.linkWrites", { names: join(t, readers) }) : t("blueprint.placeAis.linkWritesNobody"));
  }
  const from = station.inputs
    .filter((i) => i.kind === "worker")
    .flatMap((i) => (i.from === ANY_MODULE ? books.filter((b) => resolveStation(b)?.kind === "worker" && b.id !== book.id) : books.filter((b) => b.id === i.from)))
    .map(stationName);
  return from.length ? String(t("blueprint.placeAis.linkReceives", { names: join(t, [...new Set(from)]) })) : undefined;
}

function jobOf(book: Worldbook, t: Translate): string {
  const station = resolveStation(book);
  if (!station) return "";
  const voice = voiceOf(station);
  if (voice === "reply") return String(t("blueprint.roster.job.reply"));
  if (voice === "quiet") return String(t("blueprint.roster.job.quiet"));
  const trigger = station.trigger;
  if (trigger?.on === "turns") return String(t("blueprint.placeAis.jobEveryTurns", { n: trigger.every }));
  if (trigger?.on === "after") return String(t("blueprint.placeAis.jobAfter"));
  if (trigger?.on === "conditions") return String(t("blueprint.placeAis.jobConditions"));
  if (trigger?.on === "module-closed") return String(t("blueprint.placeAis.jobClosed"));
  if (trigger?.on === "ui") return String(t("blueprint.placeAis.jobUi"));
  return String(t("blueprint.placeAis.jobBehind"));
}

/** The interface's AI calls that read this module's lore — what implements a custom AI. */
export function callsReading(book: Pick<Worldbook, "id">, calls: readonly FrontendAiCall[]): FrontendAiCall[] {
  return calls.filter((c) => c.worldbookIds.includes(book.id) || c.worldbookIdPrefixes.some((p) => book.id.startsWith(p)));
}

function customRow(book: Worldbook, calls: readonly FrontendAiCall[], t: Translate, off?: boolean): PlaceAiRow {
  const mine = callsReading(book, calls);
  const first = mine[0];
  return {
    key: book.id, bookId: book.id, name: stationName(book), type: "custom",
    ...(off ? { off } : {}),
    job: first
      ? String(t("blueprint.placeAis.jobImplemented", { file: first.file, line: first.line }))
      : String(t("blueprint.placeAis.jobUnimplemented")),
    memory: first
      ? String(t(first.includeLorebook === false ? "blueprint.placeAis.memLoreNone" : first.includeLorebook === true || first.includeLorebook === "all" ? "blueprint.placeAis.memLoreAll" : "blueprint.placeAis.memLoreMatched"))
      : String(t("blueprint.placeAis.memNothing")),
    ...(first ? { code: first } : {}),
  };
}

function aiRow(book: Worldbook, books: readonly Worldbook[], t: Translate, off?: boolean, calls: readonly FrontendAiCall[] = []): PlaceAiRow {
  if (book.station?.kind === "custom") return customRow(book, calls, t, off);
  return {
    key: book.id, bookId: book.id, name: stationName(book), type: aiTypeOf(resolveStation(book)),
    ...(off ? { off } : {}),
    job: jobOf(book, t), memory: memoryOf(book, books, t), link: linkOf(book, books, t),
  };
}

/** The card's own memory, as the narrator's row says it. */
function narratorMemory(world: WorldDefinition, t: Translate): string {
  const limit = world.settings?.historyLimit;
  return String(t("blueprint.placeAis.memAll")) + (limit ? ` · ${t("blueprint.placeAis.memRecent", { n: limit })}` : "");
}

/** The situations an AI call written in code can draw lore from: the ids it
 *  names, plus every situation a template id (`still-${who}`) can resolve to. */
function codeCallTargets(call: FrontendAiCall, books: readonly Worldbook[]): Worldbook[] {
  const ids = new Set(call.worldbookIds);
  for (const prefix of call.worldbookIdPrefixes) for (const b of books) if (b.id.startsWith(prefix)) ids.add(b.id);
  return books.filter((b) => ids.has(b.id));
}

/**
 * The AI calls the card's own code makes, as rows of the AI block.
 *
 * 85 published cards call the model from their TSX, and the canvas listed
 * none of them: the AI that ran the whole card (Godot's companions, 1984's
 * room director) was nowhere on the board. On the card these rows list every
 * call; in a situation, the calls that read that situation's lore.
 */
export function codeCallRows(world: WorldDefinition, place: string | undefined, t: Translate): PlaceAiRow[] {
  const files = world.rootComponent?.files;
  if (!files) return [];
  const books = world.worldbooks ?? [];
  const rows: PlaceAiRow[] = [];
  for (const call of extractAiCallsFromFiles(files)) {
    const targets = codeCallTargets(call, books);
    // A call that implements a declared custom AI is that AI's row, not a
    // second row beside it.
    if (targets.some((b) => b.station?.kind === "custom")) continue;
    if (place !== undefined && !targets.some((b) => b.id === place)) continue;
    const names = targets.map((b) => b.station?.name?.trim() || b.name);
    const memory =
      call.includeLorebook === false ? String(t("blueprint.placeAis.memLoreNone"))
      : call.includeLorebook === true || call.includeLorebook === "all" ? String(t("blueprint.placeAis.memLoreAll"))
      : call.includeLorebook === "matched" || call.sessionContext ? String(t("blueprint.placeAis.memLoreMatched"))
      : String(t("blueprint.placeAis.memLoreNone"));
    rows.push({
      key: `code:${call.file}:${call.line}`,
      name: names.length ? names.join(" · ") : String(t("blueprint.placeAis.codeCallName", { file: call.file })),
      type: "code",
      job: String(t(place === undefined ? "blueprint.placeAis.jobFromCode" : "blueprint.placeAis.jobFromCodeHere", { file: call.file, line: call.line })),
      memory,
      ...(names.length
        ? { link: String(t(call.worldbookIds.length ? "blueprint.placeAis.linkReadsModules" : "blueprint.placeAis.linkPicksModule", { names: join(t, names) })) }
        : {}),
      code: call,
    });
  }
  return rows;
}

/** The AIs in one frame: `place` undefined is the card itself. */
export function placeAis(world: WorldDefinition, place: string | undefined, t: Translate): PlaceAis {
  const books = world.worldbooks ?? [];
  const calls = world.rootComponent?.files ? extractAiCallsFromFiles(world.rootComponent.files) : [];
  const narrator = (job: string, away?: boolean): PlaceAiRow => ({
    key: "narrator",
    // Named for what it is (owner, 10/6): an AI, the card's default one.
    name: String(t("blueprint.placeAis.defaultName")),
    type: "turn",
    job,
    memory: narratorMemory(world, t),
    ...(away ? { away } : {}),
  });
  const replies = (rows: PlaceAiRow[]) =>
    rows.filter((r) => !r.away && !r.off && (r.key === "narrator" || resolveStation(books.find((b) => b.id === r.bookId))?.kind === "narrator")).length;

  if (place === undefined) {
    const rows = [
      narrator(String(t("blueprint.roster.job.reply"))),
      ...aisLivingIn(books, "card").map((b) => aiRow(b, books, t, undefined, calls)),
      // Older shapes, drawn on the card so nothing goes missing: a
      // behind-the-scenes situation of its own (in play when its own switch
      // says), and one put nowhere (off until it is put somewhere).
      ...books.filter((b) => b.host === undefined && resolveStation(b)?.kind === "worker").sort(byOrder).map((b) => aiRow(b, books, t, undefined, calls)),
      ...aisLivingIn(books, "unplaced").map((b) => aiRow(b, books, t, true, calls)),
      // What the interface code asks the model itself: on the board at last.
      ...codeCallRows(world, undefined, t),
    ];
    return { rows, group: replies(rows) >= 2, canKeepNarrator: false, keepsNarrator: true };
  }
  const book = books.find((b) => b.id === place);
  if (!book) return { rows: [], group: false, canKeepNarrator: false, keepsNarrator: true };
  const own = resolveStation(book) || book.station?.kind === "custom" ? [aiRow(book, books, t, undefined, calls)] : [];
  const living = aisLivingIn(books, place).map((b) => aiRow(b, books, t, undefined, calls));
  const voices = [...own, ...living].filter((r) => resolveStation(books.find((b) => b.id === r.bookId))?.kind === "narrator");
  if (voices.length === 0) {
    // Nobody of its own answers here: the narrator carries on, with whatever
    // works behind the scenes beside it.
    const rows = [narrator(String(t("blueprint.placeAis.narratorStays"))), ...own, ...living, ...codeCallRows(world, place, t)];
    return { rows, group: false, canKeepNarrator: false, keepsNarrator: true };
  }
  const keeps = book.narratorHere === true;
  const rows = [
    narrator(String(t(keeps ? "blueprint.roster.job.reply" : "blueprint.placeAis.narratorAway")), !keeps),
    ...own,
    ...living,
    ...codeCallRows(world, place, t),
  ];
  return { rows, group: replies(rows) >= 2, canKeepNarrator: true, keepsNarrator: keeps };
}
