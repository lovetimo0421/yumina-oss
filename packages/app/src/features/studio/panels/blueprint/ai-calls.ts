import {
  STATION_DEFAULT_TEMPERATURE, STATION_MAX_TOKENS_LIMITS, STATION_TEMPERATURE_LIMITS, UNPLACED_WORLDBOOK_ID,
  clampAuthorSampling, clampToRange, extractAiCallsFromFiles,
  type FrontendAiCall, type ModuleStation, type WorldDefinition, type Worldbook,
} from "@yumina/engine";
import { modelLabel, modelReachWarning, stationDefaultMaxTokens } from "@/features/editor/lib/ai-call-settings";
import { cardTakenOverBy, stationName } from "./ai-roster";
import { jobOf } from "./place-ais";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 「这张卡的 AI」: every AI call the card makes, with the model and the
 * sampling each one really runs on.
 *
 * The rules are the runtime's, said once here so the table cannot promise
 * what the server does not do:
 * - The story AI's model is always the player's. The card may only recommend
 *   one. Its sampling is the player's unless the card locks its own
 *   (samplingPolicy "author"), clamped; reply length stays the player's.
 * - An AI that talks to the player on its turn answers with the player's
 *   settings. A model it names is used when the player can run it, and the
 *   player's own chat model otherwise.
 * - An AI behind the scenes (a writer, one that steps in when it is quiet,
 *   one a button calls, a custom AI) runs on the default background model
 *   and a steady 0.2 unless the author sets its own, clamped. A model the
 *   player cannot run falls back to that default.
 * - A call in the card's code: with the session context it samples like the
 *   player unless the code writes values; raw, it takes the code's values or
 *   1.0 and 2048 tokens. Its model is the player's chat model unless the code
 *   names one.
 */

export type AiCallKind = "story" | "narrator" | "behind" | "quiet" | "ui" | "custom" | "code";

/** One setting's cell: whose it is, what it says, and anything to watch. */
export interface AiCallSetting {
  /** player: the player's own settings. default: the background default.
   *  author: the card's values. code: worked out by the card's code. */
  mode: "player" | "default" | "author" | "code";
  text: string;
  /** Said under the value: the recommended model, what the default is. */
  note?: string;
  /** Amber: some players will not get what the author asked for. */
  warn?: string;
}

export interface AiCallRow {
  key: string;
  kind: AiCallKind;
  name: string;
  /** Where it lives, when that is not just its name. */
  where?: string;
  when: string;
  model: AiCallSetting;
  params: AiCallSetting;
  /** Switched off or put nowhere: it never runs. */
  off?: boolean;
  /** Where it is edited: an AI's own form, or the line in the code. */
  open: { kind: "ai"; bookId?: string; block?: string } | { kind: "code"; file: string; line: number };
}

/** A number as the table shows it: 0.2, 1, 0.95. */
const num = (n: number) => String(Math.round(n * 100) / 100);

function paramsText(t: Translate, temperature?: number, maxTokens?: number, topP?: number): string {
  return [
    temperature !== undefined ? String(t("blueprint.aiCalls.temperature", { v: num(temperature) })) : "",
    topP !== undefined ? String(t("blueprint.aiCalls.topP", { v: num(topP) })) : "",
    maxTokens !== undefined ? String(t("blueprint.aiCalls.maxTokens", { n: maxTokens })) : "",
  ].filter(Boolean).join(" · ");
}

const follows = (t: Translate): AiCallSetting => ({ mode: "player", text: String(t("blueprint.aiCalls.followPlayer")) });

/** The story AI's sampling: the player's, or the card's own, clamped. Reply
 *  length stays the player's either way. */
function storyParams(world: WorldDefinition, t: Translate): AiCallSetting {
  const settings = world.settings;
  if (settings?.samplingPolicy !== "author") return follows(t);
  const sampling = clampAuthorSampling(settings);
  return {
    mode: "author",
    text: paramsText(t, sampling.temperature, undefined, sampling.topP) || String(t("blueprint.aiCalls.authorSet")),
    note: String(t("blueprint.aiCalls.lengthPlayer")),
  };
}

/** The story AI: the card's own narrator. */
function storyRow(world: WorldDefinition, t: Translate): AiCallRow {
  const settings = world.settings;
  const takenOver = cardTakenOverBy(world.worldbooks ?? []);
  const recommended = settings?.recommendedModel?.trim();
  return {
    key: "story",
    kind: "story",
    name: String(t("blueprint.aiCalls.story")),
    // An AI always in the card's place answers every turn instead of it.
    when: takenOver
      ? String(t("blueprint.aiCalls.storyTakenOver", { name: stationName(takenOver) }))
      : String(t((world.worldbooks ?? []).some((b) => b.station?.kind === "narrator") ? "blueprint.ai.line.wakeCardTakeover" : "blueprint.ai.wakeSend")),
    ...(takenOver ? { off: true } : {}),
    model: {
      ...follows(t),
      ...(recommended ? { note: String(t("blueprint.aiCalls.recommended", { model: modelLabel(recommended) })) } : {}),
    },
    params: storyParams(world, t),
    open: { kind: "ai" },
  };
}

/** The 「AI」 block an AI's row is drawn in, for the board to bring it on screen. */
function blockOwnerOf(book: Worldbook): string | undefined {
  if (book.host === "card" || book.host === UNPLACED_WORLDBOOK_ID) return undefined;
  if (book.host !== undefined) return book.host;
  // An older shape: a situation that is its own AI is drawn in its own
  // frame; one behind the scenes of its own is drawn on the card.
  return book.station?.kind === "narrator" ? book.id : undefined;
}

function kindOf(station: ModuleStation): AiCallKind {
  if (station.kind === "narrator") return "narrator";
  if (station.kind === "custom") return "custom";
  if (station.trigger?.on === "quiet") return "quiet";
  if (station.trigger?.on === "ui") return "ui";
  return "behind";
}

function stationRow(world: WorldDefinition, book: Worldbook, books: readonly Worldbook[], t: Translate): AiCallRow {
  const station = book.station!;
  const kind = kindOf(station);
  const model = station.model?.trim();
  const host = book.host;
  const hostName = host && host !== "card" && host !== UNPLACED_WORLDBOOK_ID ? books.find((b) => b.id === host)?.name : undefined;
  const where = host === "card" ? String(t("blueprint.aiCalls.whereCard"))
    : host === UNPLACED_WORLDBOOK_ID ? String(t("blueprint.aiCalls.whereNone"))
    : hostName ?? (book.name !== stationName(book) ? book.name : undefined);
  const off = book.enabled === false || host === UNPLACED_WORLDBOOK_ID || (host !== undefined && host !== "card" && !hostName);
  const base = {
    key: `book:${book.id}`,
    kind,
    name: stationName(book),
    ...(where ? { where } : {}),
    when: kind === "custom" ? String(t("blueprint.aiCalls.whenCustom")) : jobOf(book, t),
    ...(off ? { off } : {}),
    open: { kind: "ai" as const, bookId: book.id, block: blockOwnerOf(book) },
  };
  if (kind === "narrator") {
    return {
      ...base,
      model: model
        ? { mode: "author", text: modelLabel(model), warn: modelReachWarning(model, "player", t) }
        : follows(t),
      // It answers the player's turn the way the story AI does.
      params: { ...storyParams(world, t), note: String(t("blueprint.aiCalls.narratorParams")) },
    };
  }
  const defaultTokens = stationDefaultMaxTokens(station);
  const custom = station.temperature !== undefined || station.maxTokens !== undefined;
  const temperature = clampToRange(station.temperature ?? STATION_DEFAULT_TEMPERATURE, STATION_TEMPERATURE_LIMITS);
  const maxTokens = Math.round(clampToRange(station.maxTokens ?? defaultTokens, STATION_MAX_TOKENS_LIMITS));
  return {
    ...base,
    model: model
      ? { mode: "author", text: modelLabel(model), warn: modelReachWarning(model, "default", t) }
      : { mode: "default", text: String(t("blueprint.aiCalls.followDefault")), note: String(t("blueprint.aiCalls.defaultModelNote")) },
    params: custom
      ? { mode: "author", text: paramsText(t, temperature, maxTokens) }
      : { mode: "default", text: String(t("blueprint.aiCalls.followDefault")), note: paramsText(t, temperature, maxTokens) },
  };
}

function codeRow(call: FrontendAiCall, key: string, books: readonly Worldbook[], t: Translate): AiCallRow {
  const reads = books.filter((b) => call.worldbookIds.includes(b.id) || call.worldbookIdPrefixes.some((p) => b.id.startsWith(p)));
  const model = call.model?.trim();
  let params: AiCallSetting;
  if (call.dynamicSampling) {
    params = { mode: "code", text: String(t("blueprint.aiCalls.computed")) };
  } else if (call.sessionContext) {
    const set = paramsText(t, call.temperature, call.maxTokens);
    params = set ? { mode: "author", text: set, note: String(t("blueprint.aiCalls.restPlayer")) } : follows(t);
  } else {
    // Raw: what the code writes, or the call's own defaults.
    params = {
      mode: "author",
      text: paramsText(t, call.temperature ?? 1, call.maxTokens ?? 2048),
      ...(call.temperature === undefined || call.maxTokens === undefined ? { note: String(t("blueprint.aiCalls.rawDefaults")) } : {}),
    };
  }
  return {
    key,
    kind: "code",
    name: `${call.file}:${call.line}`,
    ...(reads.length ? { where: reads.map(stationName).slice(0, 3).join(" · ") + (reads.length > 3 ? ` +${reads.length - 3}` : "") } : {}),
    when: String(t("blueprint.aiCalls.whenCode", { kind: t(`blueprint.codeCall.kind_${call.kind}`) })),
    model: model
      ? { mode: "author", text: modelLabel(model), warn: modelReachWarning(model, "player", t, "none") }
      : call.modelVariable ? { mode: "code", text: String(t("blueprint.codeCall.modelVariable", { name: call.modelVariable })) }
      : call.dynamicModel ? { mode: "code", text: String(t("blueprint.aiCalls.computed")) }
      : follows(t),
    params,
    open: { kind: "code", file: call.file, line: call.line },
  };
}

/** Every AI call on the card, story AI first, then the card's AIs in their
 *  order, then the calls its code makes. */
export function aiCallRows(world: WorldDefinition, t: Translate): AiCallRow[] {
  const books = (world.worldbooks ?? []).filter((b) => b.id !== UNPLACED_WORLDBOOK_ID);
  const rows: AiCallRow[] = [storyRow(world, t)];
  const withStation = books
    .filter((b) => b.station && (b.station.kind === "narrator" || b.station.kind === "worker" || b.station.kind === "custom"))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  for (const book of withStation) rows.push(stationRow(world, book, books, t));
  const files = world.rootComponent?.files;
  if (files) {
    // Several calls on one line (a compiled bundle) are numbered, as the
    // AI block numbers them.
    const onLine = new Map<string, number>();
    for (const call of extractAiCallsFromFiles(files)) {
      const at = `${call.file}:${call.line}`;
      const nth = (onLine.get(at) ?? 0) + 1;
      onLine.set(at, nth);
      // Assembling a context runs no model.
      if (call.kind === "context") continue;
      rows.push(codeRow(call, nth === 1 ? `code:${at}` : `code:${at}#${nth}`, books, t));
    }
  }
  return rows;
}
