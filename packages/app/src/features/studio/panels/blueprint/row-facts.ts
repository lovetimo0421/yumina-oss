import type { AudioTrack, GraphNode, SceneImage, Variable } from "@yumina/engine";
import { gameNameOf, gameSide, type GameInterface } from "@/features/editor/lib/game-interface";

/** The board's rows say what they are, so a beginner reading the canvas
 *  learns what a variable, a track or a scene image can be without opening
 *  anything — the inspector then has the whole of it. Pure: the panel hands
 *  in the draft's objects by id and its translator, and gets back what the
 *  row wears. */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface RowFacts {
  /** What kind of thing the row is, in a word or two; `accent` marks a
   *  setting that is turned on rather than a kind. */
  tags?: Array<{ text: string; accent?: boolean; hint?: string }>;
  /** The author's one line saying what the row is for. */
  note?: string;
  /** The line is the row's own quiet remark (no cue, so the AI leaves it
   *  alone), not the author's words. */
  noteQuiet?: boolean;
}

export interface RowFactsDraft {
  variables: ReadonlyMap<string, Variable>;
  audio: ReadonlyMap<string, AudioTrack>;
  images: ReadonlyMap<string, SceneImage>;
  /** Set when the card is a character inside a game (game-interface.ts). */
  game?: GameInterface | null;
  /** Variables the card's interface code writes, by id or name. */
  interfaceWrites?: ReadonlySet<string>;
  /** ...and the ones it only reads: a setting the interface runs by. */
  interfaceReads?: ReadonlySet<string>;
  /** The card's behaviours by id, for what sets each one off. */
  reactions?: ReadonlyMap<string, { when?: { eventType?: string; match?: Record<string, { value?: unknown } | undefined> } }>;
}

/** The first sentence of the author's text, and no more of it than a row
 *  can hold. */
export function noteSnippet(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const sentence = trimmed.split(/(?<=[。！？.!?])\s*|\n/)[0] ?? trimmed;
  return sentence.length > 60 ? `${sentence.slice(0, 59)}…` : sentence;
}

export function rowFacts(g: Pick<GraphNode, "id" | "kind">, draft: RowFactsDraft, t: Translate): RowFacts {
  const id = g.id.slice(g.id.indexOf(":") + 1);
  if (g.kind === "variable") {
    const v = draft.variables.get(id);
    if (!v) return {};
    // A variable's row is its name and its value. Its type, tracking and
    // rules are in its editor, one click away. The one exception is a value
    // the card's game owns: that is not in any editor, and renaming it breaks
    // the game, so the row says which side of the game it is on.
    const side = gameSide(draft.game, id);
    if (!side) {
      // State the interface keeps for itself (1984's ledger, Godot's stage):
      // the row says who writes it, since nothing else on the board does.
      if (draft.interfaceWrites?.has(v.id) || draft.interfaceWrites?.has(v.name)) return { tags: [{ text: t("blueprint.row.byInterface"), hint: t("blueprint.row.byInterfaceHint") }] };
      // A number the interface runs by (1984's "seconds crouching before he
      // notices"): changing it here changes the game, and the row says so.
      // Only a setting the AI cannot change: a value the AI writes and the
      // screen merely shows (health, hunger) is the AI's, not a setting.
      if (v.aiAccess === "none" && (draft.interfaceReads?.has(v.id) || draft.interfaceReads?.has(v.name))) return { tags: [{ text: t("blueprint.row.readByInterface"), hint: t("blueprint.row.readByInterfaceHint") }] };
      return {};
    }
    const game = gameNameOf(draft.game!, t);
    return { tags: [{ text: t(side === "in" ? "blueprint.game.in" : "blueprint.game.out"), accent: true, hint: t(side === "in" ? "blueprint.game.inHint" : "blueprint.game.outHint", { game }) }] };
  }
  if (g.kind === "rule" && g.id.startsWith("reaction:")) {
    // A behaviour the interface sets off when something happens in it (the
    // room saw the player crouch): its row says the game reports it, since
    // its trigger is a name in the code, not anything on the board.
    const when = draft.reactions?.get(id)?.when;
    if (when?.eventType !== "action:fired") return {};
    const action = when.match?.actionId?.value;
    return { tags: [{ text: t("blueprint.row.firedByInterface"), hint: t("blueprint.row.firedByInterfaceHint", { action: typeof action === "string" ? action : id }) }] };
  }
  if (g.kind === "audio") {
    const track = draft.audio.get(id);
    if (!track) return {};
    const cue = noteSnippet(track.aiNote);
    return {
      tags: [{ text: t(`audio.trackTypes.${track.type}`) }],
      note: cue ?? t("blueprint.row.audioNoCue"),
      ...(cue ? {} : { noteQuiet: true }),
    };
  }
  if (g.kind === "image") {
    const image = draft.images.get(id);
    if (!image) return {};
    // Held back by hand, or no "when" sentence yet: either way the picture
    // only appears where its code is pasted, and the row says so — the same
    // as a track with no cue.
    const cue = image.allowAiControl === false ? undefined : noteSnippet(image.scene);
    return cue ? { note: cue } : { note: t("blueprint.row.imageManual"), noteQuiet: true };
  }
  return {};
}

/** The card's own memory block: the AI that runs when no module has taken
 *  over remembers the whole conversation; then how much of it the author
 *  lets through each turn, and whether the rest becomes a summary. Each is a setting, and the panel makes every row a way to
 *  it. The judge (智能追踪) is the AI's own business and lives on its row. */
export interface CardMemoryRow {
  key: "memory" | "history" | "summary";
  icon: "memory" | "in";
  text: string;
  title: string;
}

export function cardMemoryRows(state: { historyLimit: number; summary?: boolean }, t: Translate, opts: { folded?: boolean } = {}): CardMemoryRow[] {
  // Nothing changed from the defaults: one line, not four. Any setting moved
  // off its default brings its own row, so what is different is where it
  // can be seen.
  const rows: CardMemoryRow[] = [
    { key: "memory", icon: "memory", text: t("blueprint.ctx.row.memoryCardAlone"), title: t("blueprint.ctx.row.memoryCardHint") },
  ];
  if (opts.folded && !state.historyLimit && !state.summary) return rows;
  rows.push({
    key: "history",
    icon: "in",
    text: state.historyLimit ? t("blueprint.turnCtx.historyLimitCard", { count: state.historyLimit }) : t("blueprint.turnCtx.historyAll"),
    title: t(state.historyLimit ? "entries.historyLimitHint" : "entries.historyLimitHintAll"),
  });
  if (state.summary) rows.push({ key: "summary", icon: "in", text: t("blueprint.ctx.row.summaryOn"), title: t("blueprint.insp.historySummaryHint") });
  return rows;
}
