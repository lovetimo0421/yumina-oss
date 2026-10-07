import { ANY_MODULE, UNPLACED_WORLDBOOK_ID, blockId, resolveStation, type ModuleStation, type WorldDefinition, type Worldbook } from "@yumina/engine";
import { lensAis, type LensKind } from "./ai-lens";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * The card's AIs, said in the creator's terms.
 *
 * An AI is a frame with a mind of its own: a situation whose worldbook has a
 * station. Its entries are who it is and what only it knows; around them it
 * receives things from outside (the card, the places the player is in, what
 * other AIs write for it) and it talks to someone. A frame without a station
 * is a place: while the player is there, its entries go to whichever AIs are
 * speaking. Places give; AIs receive.
 */
export interface RosterAi {
  /** The lens key: "card", "book:<id>" or "judge". */
  key: string;
  kind: LensKind;
  name: string;
  /** Set for a situation's own AI: the worldbook its station lives on. */
  bookId?: string;
  /** What it does, in a few words: 「回复玩家」, 「写给 老板娘」. */
  job: string;
  /** Where it works: a situation's name, 「整张卡」, 「幕后」. */
  where: string;
  /** Frames it works in ("" is the card). */
  presentIn: string[];
}

/** Who an AI talks to: the player on its turn, the player when it goes
 *  quiet, or only the other AIs. */
export type AiVoice = "reply" | "quiet" | "behind";
export const voiceOf = (station: Pick<ModuleStation, "kind" | "trigger">): AiVoice =>
  station.kind === "narrator" ? "reply" : station.trigger?.on === "quiet" ? "quiet" : "behind";

export const stationName = (book: Worldbook): string => book.station?.name?.trim() || book.name;

/** The AIs that read what this worker writes. Only one that talks to the
 *  player on its turn reads its wires: one that speaks when it goes quiet
 *  reads the conversation and nothing else. */
export function workerReaders(books: Worldbook[], workerId: string): Worldbook[] {
  return books.filter((b) => b.id !== workerId && resolveStation(b)?.kind === "narrator" && (resolveStation(b)?.inputs ?? []).some(
    (input) => input.kind === "worker" && (input.from === workerId || input.from === ANY_MODULE),
  ));
}

const inOrder = (a: Worldbook, b: Worldbook) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
// Only a situation that is its own AI takes the narrator's place. An AI that
// lives on the card or in a situation answers beside the others there.
const alwaysTalking = (books: Worldbook[]) => books
  .filter((b) => b.enabled !== false && b.host === undefined && b.activation.mode === "always" && resolveStation(b)?.kind === "narrator")
  .sort(inOrder);

/** The AI that replies in the card narrator's place on every turn, if one is
 *  always there: only one AI replies a turn, and it is the first in order. */
export function cardTakenOverBy(books: Worldbook[]): Worldbook | undefined {
  return alwaysTalking(books)[0];
}

/** The always-there AI ahead of this one in order: whenever both are in,
 *  that one replies, so this one never does. */
export function shadowedBy(books: Worldbook[], book: Worldbook): Worldbook | undefined {
  if (book.enabled === false || resolveStation(book)?.kind !== "narrator") return undefined;
  return alwaysTalking(books).find((o) => o.id !== book.id && inOrder(o, book) < 0);
}

const joinNames = (t: Translate, list: string[]) =>
  list.slice(0, 3).join(String(t("blueprint.ctx.flowJoin"))) + (list.length > 3 ? ` +${list.length - 3}` : "");

export function aiRoster(world: WorldDefinition, t: Translate): RosterAi[] {
  const books = world.worldbooks ?? [];
  const takeovers = new Set(books.filter((b) => resolveStation(b)?.kind === "narrator").map((b) => b.id));
  const out: RosterAi[] = [];
  for (const ai of lensAis(world, t)) {
    if (ai.kind === "card") {
      out.push({
        key: ai.key,
        kind: ai.kind,
        name: String(t("blueprint.roster.narrator")),
        job: String(t("blueprint.roster.job.reply")),
        where: String(t(takeovers.size ? "blueprint.roster.where.elsewhere" : "blueprint.roster.where.card")),
        presentIn: ["", ...books.filter((b) => !resolveStation(b)).map((b) => b.id)],
      });
      continue;
    }
    if (ai.kind === "judge") {
      out.push({ key: ai.key, kind: ai.kind, name: String(t("blueprint.roster.judge")), job: String(t("blueprint.roster.job.judge")), where: String(t("blueprint.roster.where.card")), presentIn: [] });
      continue;
    }
    const book = books.find((b) => `book:${b.id}` === ai.key);
    if (!book) continue;
    if (ai.kind === "worker") {
      const readers = workerReaders(books, book.id).map(stationName);
      out.push({
        key: ai.key,
        kind: ai.kind,
        name: stationName(book),
        bookId: book.id,
        job: readers.length ? String(t("blueprint.roster.job.writesFor", { names: joinNames(t, readers) })) : String(t("blueprint.roster.job.writesForNobody")),
        where: String(t("blueprint.roster.where.behind")),
        presentIn: [book.id],
      });
      continue;
    }
    out.push({
      key: ai.key,
      kind: ai.kind,
      name: stationName(book),
      bookId: book.id,
      job: String(t(ai.kind === "quiet" ? "blueprint.roster.job.quiet" : "blueprint.roster.job.reply")),
      where: book.name,
      presentIn: [book.id],
    });
  }
  return out;
}

/** Whether the card has more than its narrator: another AI of its own.
 *  Precise tracking is an AI too, but not one a creator places or talks
 *  about, so a card with only it is still a one-AI card. */
export const hasSeveralAis = (roster: RosterAi[]): boolean => roster.filter((ai) => ai.kind !== "judge").length > 1;

/** One thing an AI receives from outside its own frame, as a chip on its
 *  title: where it comes from, how much, and the frames to light on hover. */
export interface ReceiveChip {
  key: string;
  label: string;
  detail?: string;
  /** Frame ids (blockId.frame) the chip stands for. */
  sources: string[];
  /** Nothing reaches it: said in amber, because it will make things up. */
  warn?: boolean;
}

const INPUT_KIND = { memory: "memory", worker: "worker", variables: "variables", transcript: "transcript" } as const;

/** What reaches an AI frame from outside it, by source. */
export function aiReceives(world: WorldDefinition, book: Worldbook, t: Translate): ReceiveChip[] {
  const station = resolveStation(book);
  if (!station || !book.station) return [];
  const voice = voiceOf(book.station);
  const books = (world.worldbooks ?? []).filter((b) => b.id !== UNPLACED_WORLDBOOK_ID);
  const entries = (world.entries ?? []).filter((e) => e.enabled !== false && e.role !== "greeting" && !e.presetId && !e.worldbookId);
  const lore = voice === "quiet" ? entries.filter((e) => e.alwaysSend).length : entries.length;
  const vars = (world.variables ?? []).filter((v) => !v.internal && v.aiAccess !== "none" && !v.worldbookId).length;
  const chips: ReceiveChip[] = [];
  if (voice !== "behind" && (lore || vars)) {
    chips.push({
      key: "card",
      label: String(t("blueprint.aiFrame.fromCard")),
      detail: [lore ? String(t("blueprint.aiFrame.lore", { n: lore })) : "", vars ? String(t("blueprint.aiFrame.vars", { n: vars })) : ""].filter(Boolean).join(" · "),
      sources: [blockId.frame(null)],
    });
  }
  if (voice === "reply") {
    const places = books.filter((b) => b.id !== book.id && !resolveStation(b) && b.enabled !== false);
    if (places.length) {
      chips.push({
        key: "places",
        label: String(t("blueprint.aiFrame.fromPlaces")),
        detail: joinNames(t, places.map((p) => p.name)),
        sources: places.map((p) => blockId.frame(p.id)),
      });
    }
  }
  if (voice === "quiet") {
    // What it is given is the conversation: wires reach only an AI that
    // replies on its turn or one behind the scenes.
    chips.push({ key: "recent", label: String(t("blueprint.aiFrame.recent", { n: 12 })), sources: [] });
    return chips;
  }
  for (const input of station.inputs) {
    const kind = INPUT_KIND[input.kind];
    if (input.from === ANY_MODULE) {
      const from = books.filter((b) => b.id !== book.id && (input.kind === "worker" ? resolveStation(b)?.kind === "worker" : !!resolveStation(b)));
      chips.push({ key: `in:${input.kind}:any`, label: String(t(`blueprint.aiFrame.in.${kind}Any`)), sources: from.map((b) => blockId.frame(b.id)) });
      continue;
    }
    if (input.from === "core" && input.kind === "transcript") {
      // Read only behind the scenes; one that replies has the conversation.
      if (voice === "behind") chips.push({ key: "in:transcript:core", label: String(t("blueprint.aiFrame.recent", { n: input.limit })), sources: [] });
      continue;
    }
    const source = books.find((b) => b.id === input.from);
    if (!source && input.from !== "core") continue;
    chips.push({
      key: `in:${input.kind}:${input.from}`,
      label: source ? stationName(source) : String(t("blueprint.aiFrame.fromCard")),
      detail: String(t(`blueprint.aiFrame.in.${kind}`)),
      sources: [source ? blockId.frame(source.id) : blockId.frame(null)],
    });
  }
  if (voice === "behind" && station.inputs.length === 0) {
    chips.push({ key: "nothing", label: String(t("blueprint.aiFrame.nothing")), sources: [], warn: true });
  }
  return chips;
}

/** The line under an AI frame's name: who it talks to and when it is there
 *  (or, for one behind the scenes, when it runs), and who reads it. What
 *  keeps it from ever acting is said there too: no job to do, or another AI
 *  always answering first. */
export function aiFrameLine(world: WorldDefinition, book: Worldbook, activationLabel: string, t: Translate): { line: string; gives?: string; givesWarn?: boolean } {
  if (!book.station) return { line: activationLabel };
  const voice = voiceOf(book.station);
  const books = world.worldbooks ?? [];
  const noTask = voice !== "reply" && !book.station.task?.trim();
  if (voice !== "behind") {
    const line = [String(t(`blueprint.roster.voice.${voice}`)), activationLabel].filter(Boolean).join(" · ");
    if (noTask) return { line, gives: String(t("blueprint.aiFrame.noTask")), givesWarn: true };
    const over = voice === "reply" ? shadowedBy(books, book) : undefined;
    return over ? { line, gives: String(t("blueprint.aiFrame.shadowed", { name: stationName(over) })), givesWarn: true } : { line };
  }
  const trigger = book.station.trigger;
  const closedName = trigger?.on === "module-closed" && trigger.from !== ANY_MODULE ? books.find((b) => b.id === trigger.from)?.name : undefined;
  const when = !trigger ? String(t("blueprint.ai.wakeNone"))
    : trigger.on === "turns" ? String(t("blueprint.ai.wakeTurns", { n: trigger.every }))
    : trigger.on === "conditions" ? String(t("blueprint.ai.wakeConditions"))
    : trigger.on === "quiet" ? String(t("blueprint.ai.wakeQuiet", { n: trigger.seconds }))
    : trigger.on === "after" ? String(t("blueprint.ai.wakeAfter", { name: books.find((b) => b.id === trigger.from)?.name ?? "?" }))
    : closedName ? String(t("blueprint.ai.wakeClosed", { name: closedName })) : String(t("blueprint.ai.wakeAnyClosed"));
  const readers = workerReaders(books, book.id).map(stationName);
  // It runs only while its frame is in, so a frame that is not always in
  // says when that is.
  const line = [String(t("blueprint.roster.voice.behind")), when, book.activation.mode === "always" ? "" : activationLabel].filter(Boolean).join(" · ");
  if (noTask) return { line, gives: String(t("blueprint.aiFrame.noTask")), givesWarn: true };
  return {
    line,
    gives: readers.length ? String(t("blueprint.aiFrame.writesFor", { names: joinNames(t, readers) })) : String(t("blueprint.roster.job.writesForNobody")),
    givesWarn: readers.length === 0,
  };
}

/** Who a place hands its entries to while the player is there: every AI
 *  that talks to the player. */
export function placeGivesTo(roster: RosterAi[], t: Translate): string {
  const speakers = roster.filter((ai) => ai.kind === "card" || ai.kind === "narrator").map((ai) => ai.name);
  return String(t("blueprint.aiFrame.gives", { names: joinNames(t, speakers) }));
}
