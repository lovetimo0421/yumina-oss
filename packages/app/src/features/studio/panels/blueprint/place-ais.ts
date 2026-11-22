import { ANY_MODULE, extractAiCallsFromFiles, firstMatchIn, liveVoiceCalls, interfaceSendsChat, memoryPoolMembers, resolveStation, type FrontendAiCall, type ModuleStation, type WorldDefinition, type Worldbook } from "@yumina/engine";
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
  /** What it is handed, in a line: the entries it reads and what the code
   *  builds its messages from. */
  receives?: string;
  /** When a behind-the-scenes AI runs (幕后 · 每 3 回合), said before what it
   *  receives so the row keeps both. */
  when?: string;
  /** Its instructions as the code writes them, for the opened row. */
  instructions?: string;
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

/** What a station's wired inputs hand it, in the creator's words. */
function inputWords(station: Pick<ModuleStation, "inputs">, books: readonly Worldbook[], t: Translate): string[] {
  const nameOf = (from: string) =>
    from === ANY_MODULE ? String(t("blueprint.placeAis.anyModule"))
      : books.find((b) => b.id === from) ? stationName(books.find((b) => b.id === from)!) : String(t("blueprint.placeAis.theCard"));
  return (station.inputs ?? []).map((i) =>
    i.kind === "worker" ? String(t("blueprint.placeAis.getsWrites", { name: nameOf(i.from) }))
      : i.kind === "memory" ? String(t("blueprint.placeAis.getsPast", { name: nameOf(i.from) }))
        : i.kind === "variables" ? String(t("blueprint.placeAis.getsValues", { name: nameOf(i.from) }))
          : String(t("blueprint.placeAis.getsTranscript", { name: nameOf(i.from), n: i.limit })));
}

/**
 * What an AI that answers in the chat is handed each turn, as the server
 * builds it (routes/messages.ts): the player's line, the conversation (all of
 * it or the last N), the lore that is on (always-on and matched), the
 * variables unless the card sends none, and a station's wired inputs.
 */
function narratorIo(world: WorldDefinition, station: Pick<ModuleStation, "inputs" | "historyLimit"> | null, t: Translate): { receives: string; returns: string } {
  const limit = station?.historyLimit ?? world.settings?.historyLimit;
  const parts = [
    String(t("blueprint.placeAis.getsPlayer")),
    String(limit ? t("blueprint.placeAis.getsRecentTalk", { n: limit }) : t("blueprint.placeAis.getsHistory")),
    String(t("blueprint.placeAis.getsLore")),
    ...((world.variables?.length ?? 0) > 0 && world.settings?.variablesToAi !== "none" ? [String(t("blueprint.placeAis.getsState"))] : []),
    ...(station ? inputWords(station, world.worldbooks ?? [], t) : []),
  ];
  return { receives: parts.join(" · "), returns: `→ ${String(t("blueprint.placeAis.givesReply"))}` };
}

/**
 * What a behind-the-scenes AI is handed (lib/worker-station.ts,
 * lib/quiet-station.ts). One run on a turn, a reply or a closed situation
 * reads its own part's lore and what is wired into it, and writes notes for
 * others; one the quiet or the player's screen wakes reads the always-on
 * lore, its own, the values and the last 12 messages, and says a line.
 */
function workerIo(station: Pick<ModuleStation, "inputs" | "trigger">, books: readonly Worldbook[], t: Translate): { receives: string; returns: string } {
  const on = station.trigger?.on;
  if (on === "quiet" || on === "ui") {
    return {
      receives: [
        String(t("blueprint.placeAis.getsCoreLore")),
        String(t("blueprint.placeAis.getsOwnLore")),
        String(t("blueprint.placeAis.getsState")),
        String(t("blueprint.placeAis.getsRecentTalk", { n: 12 })),
      ].join(" · "),
      returns: `→ ${String(t("blueprint.placeAis.givesLine"))}`,
    };
  }
  return {
    receives: [String(t("blueprint.placeAis.getsOwnLore")), ...inputWords(station, books, t)].join(" · "),
    returns: `→ ${String(t("blueprint.placeAis.givesNote"))}`,
  };
}

function aiRow(world: WorldDefinition, book: Worldbook, books: readonly Worldbook[], t: Translate, off?: boolean, calls: readonly FrontendAiCall[] = []): PlaceAiRow {
  if (book.station?.kind === "custom") return customRow(book, calls, t, off);
  const station = resolveStation(book);
  const type = aiTypeOf(station);
  const job = jobOf(book, t);
  const io = !station ? {} : station.kind === "narrator" ? narratorIo(world, station, t) : { ...workerIo(station, books, t), when: job };
  return {
    key: book.id, bookId: book.id, name: stationName(book), type,
    ...(off ? { off } : {}),
    ...io,
    ...(type === "ui" && book.station ? { returns: returnsOf(book.station) } : {}),
    job, memory: memoryOf(book, books, t), link: linkOf(book, books, t),
  };
}

/** The card's own memory, as the narrator's row says it. */
function narratorMemory(world: WorldDefinition, t: Translate): string {
  const limit = world.settings?.historyLimit;
  return String(t("blueprint.placeAis.memAll")) + (limit ? ` · ${t("blueprint.placeAis.memRecent", { n: limit })}` : "");
}

/** The situations an AI call written in code can draw lore from: the ids it
 *  names, plus every situation a template id (`still-${who}`) can resolve to. */
function codeCallTargets(call: FrontendAiCall, books: readonly Worldbook[], entries: WorldDefinition["entries"] = []): Worldbook[] {
  const ids = new Set(call.worldbookIds);
  for (const prefix of call.worldbookIdPrefixes) for (const b of books) if (b.id.startsWith(prefix)) ids.add(b.id);
  for (const id of tagHomes(call.tags, entries)) ids.add(id);
  return books.filter((b) => ids.has(b.id));
}

/** The situations whose entries carry the tags a call picks its lore by
 *  (1984's referee reads the entries tagged `actor:referee`, all of them in
 *  「The world of 1984」): where that AI's instructions live. */
function tagHomes(tags: readonly string[] | undefined, entries: WorldDefinition["entries"] = []): Set<string> {
  const homes = new Set<string>();
  if (!tags?.length) return homes;
  for (const e of entries) if (e.worldbookId && e.enabled !== false && (e.tags ?? []).some((tag) => tags.includes(tag))) homes.add(e.worldbookId);
  return homes;
}

const NOT_READ = /^(?:seed|calm|fresh|voiceless|jerks|debug|strict|budget|budgetMs|key|model|temperature|maxTokens|timeout|signal|fallback)$/;

/** What a call is handed and what it answers, in a line: the entries it picks
 *  by tag (and whose they are), then what the code builds its messages from,
 *  the common words said in the creator's terms and the rest as written. */
function callIo(
  call: Pick<FrontendAiCall, "inputs" | "tags" | "returns">,
  world: WorldDefinition,
  t: Translate,
): { receives?: string; returns?: string } {
  const parts: string[] = [];
  const tagged = (world.entries ?? []).filter((e) => e.enabled !== false && (e.tags ?? []).some((tag) => call.tags?.includes(tag)));
  if (tagged.length) {
    const home = (world.worldbooks ?? []).find((b) => b.id === tagged[0]!.worldbookId);
    parts.push(String(t("blueprint.placeAis.readsTagged", { count: tagged.length, place: home?.name ?? String(t("blueprint.placeAis.theCard")) })));
  }
  const seen = new Set(parts);
  for (const key of call.inputs ?? []) {
    // Switches and plumbing (a seed, calm mode, a fresh start) are not
    // something the AI reads; and the entries it is handed are said above.
    if (NOT_READ.test(key) || (tagged.length && /^(?:entries|world|lore)$/.test(key))) continue;
    const word = String(t(`blueprint.placeAis.input.${key}`, { defaultValue: key }));
    if (!word || seen.has(word)) continue;
    seen.add(word);
    parts.push(word);
  }
  const shown = parts.slice(0, 6);
  const more = parts.length - shown.length;
  return {
    ...(shown.length ? { receives: shown.join(" · ") + (more > 0 ? ` ${String(t("blueprint.placeAis.andMore", { count: more }))}` : "") } : {}),
    ...(call.returns?.length ? { returns: `→ { ${call.returns.slice(0, 4).join(", ")}${call.returns.length > 4 ? ", …" : ""} }` } : {}),
  };
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
    const targets = codeCallTargets(call, books, world.entries);
    // A call that implements a declared custom AI is that AI's row, not a
    // second row beside it.
    if (targets.some((b) => b.station?.kind === "custom")) continue;
    // Nor is the fallback a card's screen takes when calling one of its AIs
    // did not answer: it runs that AI's own task and model (1984's referee).
    if (call.fallbackOfCallAi && books.some((b) => b.station?.kind === "worker" && b.station.trigger?.on === "ui")) continue;
    if (place !== undefined && !targets.some((b) => b.id === place)) continue;
    // An AI whose instructions live in a situation (the entries it reads are
    // that situation's) is drawn there, with them, not again on the card.
    if (place === undefined && targets.length > 0) continue;
    const names = targets.map((b) => b.station?.name?.trim() || b.name);
    const memory =
      call.includeLorebook === false ? String(t("blueprint.placeAis.memLoreNone"))
      : call.includeLorebook === true || call.includeLorebook === "all" ? String(t("blueprint.placeAis.memLoreAll"))
      : call.includeLorebook === "matched" || call.sessionContext ? String(t("blueprint.placeAis.memLoreMatched"))
      : String(t("blueprint.placeAis.memLoreNone"));
    rows.push({
      key,
      // What the code itself calls it ("referee"), when a message beside the
      // call says; a bare 「界面代码 · index.tsx」 told five AIs apart by nothing.
      // The situation it reads is where it is drawn, not who it is: a referee
      // reading 「The world of 1984」 is still the referee.
      name: call.label ? capitalize(call.label) : names.length ? names.join(" · ") : String(t("blueprint.placeAis.codeCallName", { file: call.file })),
      type: "script",
      // What it is asked to do, in the instructions' own first sentence.
      job: call.purpose ?? String(t(place === undefined ? "blueprint.placeAis.jobFromCode" : "blueprint.placeAis.jobFromCodeHere", { file: call.file, line: call.line })),
      memory,
      ...callIo(call, world, t),
      ...(call.instructions ? { instructions: call.instructions } : {}),
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
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The platform's AIs the card's own screen sets going: a film made of the
 * story (a director AI cuts each reply into shots, a video model shoots
 * them), lines read aloud, the player's voice typed out, a picture for a
 * reply. They cost the player and change what they see, and the screen's
 * code is the only place they were written down (the Movie Edition's whole
 * film pipeline was nowhere on the board).
 */
export function platformRows(world: WorldDefinition, t: Translate): PlaceAiRow[] {
  const files = world.rootComponent?.files;
  if (!files) return [];
  const rows: PlaceAiRow[] = [];
  const row = (key: string, at: { file: string; line: number }, name: string, job: string): PlaceAiRow => ({
    key: `platform:${key}`, name: String(t(name)), type: "platform", job: String(t(job)), memory: "", codeAt: at,
    receives: String(t(`${name}Gets`)), returns: `→ ${String(t(`${name}Gives`))}`,
  });
  const film = firstMatchIn(files, /\brealtimeVideo\b/);
  if (film) {
    rows.push(row("film-director", film, "blueprint.placeAis.filmDirector", "blueprint.placeAis.filmDirectorJob"));
    rows.push(row("film-camera", film, "blueprint.placeAis.filmCamera", "blueprint.placeAis.filmCameraJob"));
  }
  const tts = firstMatchIn(files, /\btts\b[^;]{0,60}\bspeak\b/);
  if (tts) rows.push(row("tts", tts, "blueprint.placeAis.tts", "blueprint.placeAis.ttsJob"));
  const stt = firstMatchIn(files, /\bvoice\s*\??\.\s*record\b/);
  if (stt) rows.push(row("voice-input", stt, "blueprint.placeAis.voiceInput", "blueprint.placeAis.voiceInputJob"));
  const art = firstMatchIn(files, /\billustrateMessage\b|\bsetAutoTurnImages\b/);
  if (art) rows.push(row("illustrate", art, "blueprint.placeAis.illustrate", "blueprint.placeAis.illustrateJob"));
  return rows;
}

/** `place`: the situation asked about (undefined is the card). The
 *  conversation is drawn where the entries it is told live (1984: the entries
 *  tagged `actor:voice`, all in 「The official on the telescreen」), and on the
 *  card only when they live nowhere in particular. */
const voiceHere = (world: WorldDefinition, t: Translate, place: string): PlaceAiRow[] => {
  const row = liveVoiceRow(world, t, place);
  return row ? [namedByNote(world, row)] : [];
};

function liveVoiceRow(world: WorldDefinition, t: Translate, place?: string): PlaceAiRow | null {
  const files = world.rootComponent?.files;
  const at = files ? firstMatchIn(files, /\brealtimeVoice\b/) : null;
  if (!at) return null;
  const read = files ? liveVoiceCalls(files)[0] : undefined;
  const homes = tagHomes(read?.tags, world.entries);
  if (place === undefined ? homes.size > 0 : !homes.has(place)) return null;
  return {
    key: `voice:${at.file}:${at.line}`,
    name: String(t("blueprint.placeAis.liveVoice")),
    type: "script",
    job: read?.purpose ?? String(t("blueprint.placeAis.liveVoiceJob")),
    memory: "",
    codeAt: read ? { file: read.file, line: read.line } : at,
    ...(read ? callIo(read, world, t) : {}),
    ...(read?.instructions ? { instructions: read.instructions } : {}),
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
    ...narratorIo(world, null, t),
    // 「卡的 AI 在这里继续说」, 「这里由下面的 AI 说」: said before what it gets.
    ...(job !== String(t("blueprint.roster.job.reply")) ? { when: job } : {}),
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
      ...aisLivingIn(books, "card").map((b) => aiRow(world, b, books, t, undefined, calls)),
      // Older shapes, drawn on the card so nothing goes missing: a
      // behind-the-scenes situation of its own (in play when its own switch
      // says), and one put nowhere (off until it is put somewhere).
      ...books.filter((b) => b.host === undefined && resolveStation(b)?.kind === "worker").sort(byOrder).map((b) => aiRow(world, b, books, t, undefined, calls)),
      ...aisLivingIn(books, "unplaced").map((b) => aiRow(world, b, books, t, true, calls)),
      // What the interface code asks the model itself: on the board at last.
      ...(voice ? [voice] : []),
      ...codeCallRows(world, undefined, t),
      ...gameAiRows(world, t),
      ...platformRows(world, t),
    ];
    return { rows, group: replies(rows) >= 2, canKeepNarrator: false, keepsNarrator: true };
  }
  const book = books.find((b) => b.id === place);
  if (!book) return { rows: [], group: false, canKeepNarrator: false, keepsNarrator: true };
  // A situation the card's game reads (Crazy Dave's prose) is spoken by that
  // game AI; the chat's turn-based AI never reads it.
  const gameHere = gameAiRows(world, t).filter((r) => r.game?.book === place);
  if (gameHere.length) return { rows: gameHere, group: false, canKeepNarrator: false, keepsNarrator: false };
  const own = resolveStation(book) || book.station?.kind === "custom" ? [aiRow(world, book, books, t, undefined, calls)] : [];
  const living = aisLivingIn(books, place).map((b) => aiRow(world, b, books, t, undefined, calls));
  const voices = [...own, ...living].filter((r) => resolveStation(books.find((b) => b.id === r.bookId))?.kind === "narrator");
  if (voices.length === 0) {
    // Nobody of its own answers here: the narrator carries on, with whatever
    // works behind the scenes beside it.
    // (Not when nothing ever calls the story AI: 1984's telescreen official.)
    const rows = [...(storyAiIsCalled(world) ? [narrator(String(t("blueprint.placeAis.narratorStays")))] : []), ...own, ...living, ...voiceHere(world, t, place), ...codeCallRows(world, place, t)];
    return { rows, group: false, canKeepNarrator: false, keepsNarrator: true };
  }
  const keeps = book.narratorHere === true;
  const rows = [
    narrator(String(t(keeps ? "blueprint.roster.job.reply" : "blueprint.placeAis.narratorAway")), !keeps),
    ...own,
    ...living,
    ...voiceHere(world, t, place),
    ...codeCallRows(world, place, t),
  ];
  return { rows, group: replies(rows) >= 2, canKeepNarrator: true, keepsNarrator: keeps };
}
