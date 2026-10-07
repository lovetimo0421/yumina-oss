import type { AudioTrack, GraphNode, SceneImage, Variable } from "@yumina/engine";

/** The board's rows say what they are, so a beginner reading the canvas
 *  learns what a variable, a track or a scene image can be without opening
 *  anything — the inspector then has the whole of it. Pure: the panel hands
 *  in the draft's objects by id and its translator, and gets back what the
 *  row wears. */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface RowFacts {
  /** What kind of thing the row is, in a word or two; `accent` marks a
   *  setting that is turned on rather than a kind. */
  tags?: Array<{ text: string; accent?: boolean }>;
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
    // rules are in its editor, one click away.
    return {};
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
 *  lets through each turn, whether the rest becomes a summary, and whether a
 *  note is pinned. Each is a setting, and the panel makes every row a way to
 *  it. The judge (智能追踪) is the AI's own business and lives on its row. */
export interface CardMemoryRow {
  key: "memory" | "history" | "summary" | "pinned";
  icon: "memory" | "in";
  text: string;
  title: string;
}

export function cardMemoryRows(state: { historyLimit: number; summary?: boolean; pinned?: string }, t: Translate, opts: { folded?: boolean } = {}): CardMemoryRow[] {
  const pinned = (state.pinned ?? "").trim();
  // Nothing changed from the defaults: one line, not four. Any setting moved
  // off its default brings its own row, so what is different is where it
  // can be seen.
  const rows: CardMemoryRow[] = [
    { key: "memory", icon: "memory", text: t("blueprint.ctx.row.memoryCardAlone"), title: t("blueprint.ctx.row.memoryCardHint") },
  ];
  if (opts.folded && !state.historyLimit && !state.summary && !pinned) return rows;
  rows.push({
    key: "history",
    icon: "in",
    text: state.historyLimit ? t("blueprint.turnCtx.historyLimitCard", { count: state.historyLimit }) : t("blueprint.turnCtx.historyAll"),
    title: t(state.historyLimit ? "entries.historyLimitHint" : "entries.historyLimitHintAll"),
  });
  if (state.summary) rows.push({ key: "summary", icon: "in", text: t("blueprint.ctx.row.summaryOn"), title: t("blueprint.insp.historySummaryHint") });
  if (pinned) rows.push({ key: "pinned", icon: "in", text: t("blueprint.ctx.row.pinnedRow", { text: pinned.length > 40 ? `${pinned.slice(0, 40)}…` : pinned }), title: pinned });
  return rows;
}
