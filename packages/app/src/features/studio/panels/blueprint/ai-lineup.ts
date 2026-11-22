import { isContinuityOwned, type WorldDefinition } from "@yumina/engine";
import { normaliseMultiplayer } from "@yumina/shared";
import type { PlaceAis, PlaceAiRow } from "./place-ais";

/**
 * Every AI a card runs, in the order a turn meets them.
 *
 * The board shows each place's AIs at the foot of its tile, and the
 * platform's own AIs nowhere — yet those change numbers on every turn and
 * cost money. This is the one list of all of them, said in the order the
 * player's message travels: who answers, what runs right after, what the
 * card's screen or events call, and what the platform keeps running in the
 * background. Pure, so the card that draws it stays a picture of this.
 */

export type LineupSection = "answer" | "after" | "called" | "platform";

export interface LineupItem {
  key: string;
  name: string;
  /** The place it lives in — the card, or a situation by name. */
  where?: string;
  /** What it does, in the row's own words (place-ais), or a platform line key. */
  job: string;
  /** What it remembers, for the AIs the card defines. */
  memory?: string;
  /** The place on the board to go to: its 「这里的 AI」 block's owner ("" = the card). */
  owner?: string;
  platform?: boolean;
  /** How many of the card's numbers it looks after (the judge, the repair). */
  values?: number;
}

export interface Lineup {
  sections: Array<{ id: LineupSection; items: LineupItem[] }>;
  total: number;
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** The lineup's 「座位 AI」: set in the card settings, not on the board. */
export const SEAT_AI_KEY = "multiplayer:seats";

export function aiLineup(
  world: Pick<WorldDefinition, "worldbooks" | "variables" | "continuity" | "audioTracks" | "sceneImages"> & { settings?: Pick<NonNullable<WorldDefinition["settings"]>, "multiplayer"> },
  places: ReadonlyMap<string, PlaceAis>,
  placeName: (owner: string) => string,
  t: Translate,
): Lineup {
  const answer: LineupItem[] = [];
  const after: LineupItem[] = [];
  const called: LineupItem[] = [];
  const books = new Map((world.worldbooks ?? []).map((b) => [b.id, b]));
  const platformCalled: LineupItem[] = [];
  const seen = new Set<string>();
  for (const [owner, place] of places) {
    for (const row of place.rows) {
      if (row.off || row.away) continue;
      // The card's AI carrying on in a situation is the same AI, not
      // another one; and an AI listed by more than one place is one AI.
      if (!row.bookId && row.key === "narrator" && owner !== "") continue;
      const id = row.bookId ?? `${owner}|${row.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const item: LineupItem = {
        key: id,
        name: row.name,
        where: placeName(owner),
        job: row.job,
        ...(row.memory ? { memory: row.memory } : {}),
        owner,
      };
      // The platform's AIs the card's screen sets going (film, voice,
      // pictures) stand with the platform's own.
      if (row.type === "platform") { platformCalled.push({ ...item, platform: true }); continue; }
      const section = sectionOf(row, books);
      (section === "answer" ? answer : section === "after" ? after : called).push(item);
    }
  }
  // 联机 by rules: the AI that sits in a seat no friend took, called by the
  // table when that seat's turn comes.
  const multiplayer = normaliseMultiplayer(world.settings?.multiplayer);
  if (multiplayer?.mode === "rules") {
    const job = [multiplayer.ai.names.join(", "), multiplayer.ai.model ?? ""].filter(Boolean).join(" · ");
    called.push({ key: SEAT_AI_KEY, name: t("blueprint.multiplayer.seatAi"), job: job || t("blueprint.multiplayer.aiSeats") });
  }
  const platform: LineupItem[] = [...platformCalled];
  // The judge only has work on a card that gives it some: a number set to
  // precise tracking, music or a sound with a cue, a scene image with one.
  const judgedValues = (world.variables ?? []).filter((v) => isContinuityOwned(world, v)).length;
  const judged = judgedValues > 0
    || (world.audioTracks ?? []).some((track) => !!track.aiNote?.trim())
    || (world.sceneImages ?? []).some((img) => img.allowAiControl !== false && !!img.scene?.trim());
  if (judged && world.continuity?.enabled !== false) {
    platform.push({ key: "platform:judge", name: t("blueprint.lineup.judge"), job: t("blueprint.lineup.judgeJob"), platform: true, ...(judgedValues ? { values: judgedValues } : {}) });
  }
  // The repair asks about every number the story AI may write and the judge
  // does not own.
  const repairable = (world.variables ?? []).filter((v) => !v.internal && !v.formula && (v.aiAccess ?? "write") === "write" && !isContinuityOwned(world, v)).length;
  if (repairable > 0) {
    platform.push({ key: "platform:repair", name: t("blueprint.lineup.repair"), job: t("blueprint.lineup.repairJob"), platform: true, values: repairable });
  }
  platform.push({ key: "platform:memory", name: t("blueprint.lineup.memory"), job: t("blueprint.lineup.memoryJob"), platform: true });
  platform.push({ key: "platform:summary", name: t("blueprint.lineup.summary"), job: t("blueprint.lineup.summaryJob"), platform: true });

  const sections: Lineup["sections"] = [
    { id: "answer", items: answer },
    { id: "after", items: after },
    { id: "called", items: called },
    { id: "platform", items: platform },
  ];
  return {
    sections: sections.filter((s) => s.items.length > 0),
    total: answer.length + after.length + called.length + platform.length,
  };
}

/** Which part of the turn an AI belongs to: a place's narrator answers; a
 *  worker on the player's turn runs after the answer; anything called by
 *  the screen, an event, a script or the card's game is called. */
export function sectionOf(row: Pick<PlaceAiRow, "type" | "bookId">, books: ReadonlyMap<string, { station?: { kind?: string } | null }>): LineupSection {
  if (row.type !== "turn") return "called";
  const kind = row.bookId ? books.get(row.bookId)?.station?.kind : "narrator";
  return kind === "worker" ? "after" : "answer";
}
