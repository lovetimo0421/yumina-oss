import { ANY_MODULE, extractAiCallsFromFiles, firstMatchIn, interfaceSendsChat, memoryPoolMembers, resolveStation, type FrontendAiCall, type ModuleStation, type WorldDefinition, type Worldbook } from "@yumina/engine";
import { stationName, voiceOf, workerReaders } from "./ai-roster";
import type { AiRowType, AiType } from "./add-ai";

/** Which kind an AI is, by what calls it: the player's turn (it answers, or
 *  works right after an answer / every few turns), the player's screen (a
 *  button), or an event in the card (a value, a scenario ending, a
 *  silence). */
export function aiTypeOf(station: Pick<ModuleStation, "kind" | "trigger"> | null | undefined): AiType {
  if (station?.kind === "custom") return "custom";
  if (!station || station.kind === "narrator") return "turn";
  const on = station.trigger?.on;
  if (on === "turns" || on === "after") return "turn";
  if (on === "ui") return "ui";
  return "event";
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
  /** Turn-based, UI-based, event-based, custom — or a call in the code. */
  type: AiRowType;
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
  /** What a called AI hands back, for the row: `→ { mood, reply }`. Set on
   *  the kinds the card's screen calls (UI-based, custom). */
  returns?: string;
  /** Where in the interface code a row without a call of its own lives
   *  (a live voice conversation): a click opens the code there. */
  codeAt?: { file: string; line: number };
  /** An AI call the interface code makes itself — no settings of its own;
   *  the row says what the scan read off the call and opens the file. */
  code?: FrontendAiCall;
  /** An AI the card's game runs on our server, as the card declares it
   *  (`game.ais`): not in the card, so the row only says what it is. */
  game?: { gets?: string; returns?: string; where?: string; book?: string };
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

export function jobOf(book: Worldbook, t: Translate): string {
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

/** The answer's shape in one line: its fields, or plain text. */
export function returnsOf(station: Pick<ModuleStation, "output" | "answer">): string {
  const fields = (station.output ?? []).map((f) => f.name).filter(Boolean);
  return fields.length ? `→ { ${fields.slice(0, 4).join(", ")}${fields.length > 4 ? ", …" : ""} }` : station.answer === "json" ? "→ JSON" : "→ text";
}

function customRow(book: Worldbook, calls: readonly FrontendAiCall[], t: Translate, off?: boolean): PlaceAiRow {
  const mine = callsReading(book, calls);
  const first = mine[0];
  return {
    key: book.id, bookId: book.id, name: stationName(book), type: "custom",
    ...(off ? { off } : {}),
    returns: returnsOf(book.station!),
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
  const type = aiTypeOf(resolveStation(book));
  return {
    key: book.id, bookId: book.id, name: stationName(book), type,
    ...(off ? { off } : {}),
    ...(type === "ui" && book.station ? { returns: returnsOf(book.station) } : {}),
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
/**
 * A code AI the creator has written a note on is called what the note calls
 * it: "Rival bidder: plays whoever…" names the row "Rival bidder". Ten rows
 * of "界面代码 · auction-panel.tsx" said where each AI is, never what it is.
 * Only a short lead before a colon counts; a note that is one sentence leaves
 * the name alone.
 */
export function namedByNote(world: WorldDefinition, row: PlaceAiRow): PlaceAiRow {
  if (row.bookId || !(row.code || row.codeAt)) return row;
  const target = `ai:${row.key}`;
  const note = (world.graphLayout?.notes ?? []).find((n) => (n.targets?.length ? n.targets.length === 1 && n.targets[0] === target : n.on === target));
  const lead = /^\s*([^:：\n]{2,28}?)\s*[:：]\s*\S/.exec(note?.text ?? "")?.[1]?.trim();
  return lead ? { ...row, name: lead } : row;
}

export function codeCallRows(world: WorldDefinition, place: string | undefined, t: Translate): PlaceAiRow[] {
  const files = world.rootComponent?.files;
  if (!files) return [];
  const books = world.worldbooks ?? [];
  const rows: PlaceAiRow[] = [];
  // Calls already met on each file:line. A compiled bundle is one line, so
  // file:line gave all its calls one key (React's duplicate keys, every row
  // lit at once). The first call on a line keeps the bare key — the one a
  // sticky note on a hand-written card is already stuck to — and the ones
  // after it are numbered in source order. Counted before any call is
  // filtered out, so a call has the same key on the card and in a situation.
  const onLine = new Map<string, number>();
  for (const call of extractAiCallsFromFiles(files)) {
    const at = `${call.file}:${call.line}`;
    const nth = (onLine.get(at) ?? 0) + 1;
    onLine.set(at, nth);
    const key = nth === 1 ? `code:${at}` : `code:${at}#${nth}`;
    const targets = codeCallTargets(call, books);
    // A call that implements a declared custom AI is that AI's row, not a
    // second row beside it.
    if (targets.some((b) => b.station?.kind === "custom")) continue;
    // Nor is the fallback a card's screen takes when calling one of its AIs
    // did not answer: it runs that AI's own task and model (1984's referee).
    if (call.fallbackOfCallAi && books.some((b) => b.station?.kind === "worker" && b.station.trigger?.on === "ui")) continue;
    if (place !== undefined && !targets.some((b) => b.id === place)) continue;
    const names = targets.map((b) => b.station?.name?.trim() || b.name);
    const memory =
      call.includeLorebook === false ? String(t("blueprint.placeAis.memLoreNone"))
      : call.includeLorebook === true || call.includeLorebook === "all" ? String(t("blueprint.placeAis.memLoreAll"))
      : call.includeLorebook === "matched" || call.sessionContext ? String(t("blueprint.placeAis.memLoreMatched"))
      : String(t("blueprint.placeAis.memLoreNone"));
    rows.push({
      key,
      name: names.length ? names.join(" · ") : String(t("blueprint.placeAis.codeCallName", { file: call.file })),
      type: "script",
      job: String(t(place === undefined ? "blueprint.placeAis.jobFromCode" : "blueprint.placeAis.jobFromCodeHere", { file: call.file, line: call.line })),
      memory,
      ...(names.length
        ? { link: String(t(call.worldbookIds.length ? "blueprint.placeAis.linkReadsModules" : "blueprint.placeAis.linkPicksModule", { names: join(t, names) })) }
        : {}),
      code: call,
    });
  }
  // Two calls reading the same situations had the same name (Godot's two
  // companion calls), two identical rows nobody could tell apart: such rows
  // say where in the code each one is.
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
  // A name that is already the file ("界面代码 · phone.tsx") only needs the
  // line: "界面代码 · phone.tsx · phone.tsx:1464" said the file twice.
  for (const row of rows) {
    if ((seen.get(row.name) ?? 0) < 2 || !row.code) continue;
    const bare = String(t("blueprint.placeAis.codeCallName", { file: row.code.file }));
    row.name = row.name === bare ? `${row.name}:${row.code.line}` : `${row.name} · ${row.code.file}:${row.code.line}`;
  }
  return rows.map((row) => namedByNote(world, row));
}

/** A spoken conversation the interface holds with an AI (api.realtimeVoice):
 *  an AI of the card's like any other, though nothing on the card configures
 *  it. 1984's official on the telescreen is one. */
function liveVoiceRow(world: WorldDefinition, t: Translate): PlaceAiRow | null {
  const files = world.rootComponent?.files;
  const at = files ? firstMatchIn(files, /\brealtimeVoice\b/) : null;
  if (!at) return null;
  return {
    key: `voice:${at.file}:${at.line}`,
    name: String(t("blueprint.placeAis.liveVoice")),
    type: "script",
    job: String(t("blueprint.placeAis.liveVoiceJob")),
    memory: "",
    codeAt: at,
  };
}

/** The card's own AI answers what the player sends into the chat. An
 *  interface of the card's own that sends nothing there (1984, Godot: their
 *  code calls the AIs itself) never wakes it. A game page is its own case. */
export function storyAiIsCalled(world: WorldDefinition): boolean {
  const game = (world as { game?: { path?: unknown; ais?: unknown } | null }).game;
  // A game page whose game runs its own AIs never mounts the chat: the
  // story AI is not who speaks there.
  if (typeof game?.path === "string" && Array.isArray(game.ais) && game.ais.length) return false;
  const files = world.rootComponent?.files;
  if (!files || Object.keys(files).length === 0) return true;
  if (typeof game?.path === "string") return true;
  return interfaceSendsChat(files);
}

/** The situations the card's game reads its AIs' prose from. Drawn as in
 *  use whatever their own switch says: they are switched off so the card's
 *  chat never reads them, and the game reads them all the same. */
export function gameBookIds(world: WorldDefinition): Set<string> {
  const ais = (world as { game?: { ais?: unknown } | null }).game?.ais;
  return new Set(Array.isArray(ais) ? ais.map((a) => (a && typeof a === "object" ? (a as { book?: unknown }).book : undefined)).filter((b): b is string => typeof b === "string" && !!b) : []);
}

const READS_ENTRIES = /\bapi\s*\??\.\s*entries\b/;
/** Once per version of the code: 1984's interface is two million characters
 *  and every entry row on the board asks. */
const codeFactsCache = new WeakMap<object, { game: unknown; called: boolean; readsEntries: boolean }>();
function codeFacts(world: WorldDefinition): { called: boolean; readsEntries: boolean } {
  const files = world.rootComponent?.files;
  const game = (world as { game?: unknown }).game;
  if (!files) return { called: storyAiIsCalled(world), readsEntries: false };
  const hit = codeFactsCache.get(files);
  if (hit && hit.game === game) return hit;
  const facts = { game, called: storyAiIsCalled(world), readsEntries: Object.values(files).some((src) => typeof src === "string" && READS_ENTRIES.test(src)) };
  codeFactsCache.set(files, facts);
  return facts;
}

/** Who reads an entry when the card's chat is not where it goes: the game
 *  (a situation its AI names, Crazy Dave's), or the interface code, which on
 *  a card whose chat never speaks reads plain lore itself (1984's telescreen
 *  official, handed to its live voice). Null: the chat's AI, as usual. */
export function entryReadBy(world: WorldDefinition, worldbookId: string | null | undefined): "game" | "interface" | null {
  if (worldbookId && gameBookIds(world).has(worldbookId)) return "game";
  const facts = codeFacts(world);
  if (facts.called || !facts.readsEntries) return null;
  const book = worldbookId ? (world.worldbooks ?? []).find((b) => b.id === worldbookId) : undefined;
  return book && (resolveStation(book) || book.station?.kind === "custom") ? null : "interface";
}

/** The AIs the card's game runs itself (`game.ais`), one row each. */
export function gameAiRows(world: WorldDefinition, t: Translate): PlaceAiRow[] {
  const ais = (world as { game?: { ais?: unknown } | null }).game?.ais;
  if (!Array.isArray(ais)) return [];
  return ais.flatMap((ai, i): PlaceAiRow[] => {
    if (!ai || typeof ai !== "object" || typeof (ai as { name?: unknown }).name !== "string") return [];
    const { name, gets, returns, where, book } = ai as { name: string; gets?: unknown; returns?: unknown; where?: unknown; book?: unknown };
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return [{
      key: `game:${i}`,
      name: name.trim() || String(t("blueprint.placeAis.defaultName")),
      type: "game",
      job: String(t("blueprint.placeAis.jobGame")),
      memory: String(t("blueprint.placeAis.memGame")),
      game: { ...(text(gets) ? { gets: text(gets) } : {}), ...(text(returns) ? { returns: text(returns) } : {}), ...(text(where) ? { where: text(where) } : {}), ...(text(book) ? { book: text(book) } : {}) },
    }];
  });
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
    const called = storyAiIsCalled(world);
    const found = liveVoiceRow(world, t);
    const voice = found && namedByNote(world, found);
    const rows = [
      // The card's own AI only when something calls it: a screen that sends
      // no chat message (1984) or a game page (PvZ) never does, and a row that
      // can never answer is not an AI on the card. The Context block says why.
      ...(called ? [narrator(String(t("blueprint.roster.job.reply")))] : []),
      ...aisLivingIn(books, "card").map((b) => aiRow(b, books, t, undefined, calls)),
      // Older shapes, drawn on the card so nothing goes missing: a
      // behind-the-scenes situation of its own (in play when its own switch
      // says), and one put nowhere (off until it is put somewhere).
      ...books.filter((b) => b.host === undefined && resolveStation(b)?.kind === "worker").sort(byOrder).map((b) => aiRow(b, books, t, undefined, calls)),
      ...aisLivingIn(books, "unplaced").map((b) => aiRow(b, books, t, true, calls)),
      // What the interface code asks the model itself: on the board at last.
      ...(voice ? [voice] : []),
      ...codeCallRows(world, undefined, t),
      ...gameAiRows(world, t),
    ];
    return { rows, group: replies(rows) >= 2, canKeepNarrator: false, keepsNarrator: true };
  }
  const book = books.find((b) => b.id === place);
  if (!book) return { rows: [], group: false, canKeepNarrator: false, keepsNarrator: true };
  // A situation the card's game reads (Crazy Dave's prose) is spoken by that
  // game AI; the chat's turn-based AI never reads it.
  const gameHere = gameAiRows(world, t).filter((r) => r.game?.book === place);
  if (gameHere.length) return { rows: gameHere, group: false, canKeepNarrator: false, keepsNarrator: false };
  const own = resolveStation(book) || book.station?.kind === "custom" ? [aiRow(book, books, t, undefined, calls)] : [];
  const living = aisLivingIn(books, place).map((b) => aiRow(b, books, t, undefined, calls));
  const voices = [...own, ...living].filter((r) => resolveStation(books.find((b) => b.id === r.bookId))?.kind === "narrator");
  if (voices.length === 0) {
    // Nobody of its own answers here: the narrator carries on, with whatever
    // works behind the scenes beside it.
    // (Not when nothing ever calls the story AI: 1984's telescreen official.)
    const rows = [...(storyAiIsCalled(world) ? [narrator(String(t("blueprint.placeAis.narratorStays")))] : []), ...own, ...living, ...codeCallRows(world, place, t)];
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
