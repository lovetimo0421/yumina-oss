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

/** The card's own memory block, three facts about the AI that runs when no
 *  module has taken over: it remembers the whole conversation, how much of
 *  it the author lets through each turn, and whether the judge keeps the
 *  numbers, music and scene images in step with the story. Each is a
 *  setting, and the panel makes every row a way to it. */
export interface CardMemoryRow {
  key: "memory" | "history" | "continuity";
  icon: "memory" | "in" | "judge";
  text: string;
  title: string;
}

export function cardMemoryRows(state: { historyLimit: number; continuityEnabled: boolean }, t: Translate, opts: { folded?: boolean } = {}): CardMemoryRow[] {
  // Nothing changed from the defaults: one line, not three. Three rows saying
  // "the usual" were the tallest thing at the foot of every new card. Any
  // setting moved off its default brings all three back, so what is
  // different is where it can be seen.
  if (opts.folded && !state.historyLimit && state.continuityEnabled) {
    return [{
      key: "memory",
      icon: "memory",
      text: `${t("blueprint.ctx.row.memoryCardAlone")} · ${t("blueprint.ctx.row.continuityOn")}`,
      title: t("blueprint.ctx.row.memoryCardHint"),
    }];
  }
  return [
    { key: "memory", icon: "memory", text: t("blueprint.ctx.row.memoryCardAlone"), title: t("blueprint.ctx.row.memoryCardHint") },
    {
      key: "history",
      icon: "in",
      text: state.historyLimit ? t("blueprint.turnCtx.historyLimitCard", { count: state.historyLimit }) : t("blueprint.turnCtx.historyAll"),
      title: t(state.historyLimit ? "entries.historyLimitHint" : "entries.historyLimitHintAll"),
    },
    {
      key: "continuity",
      icon: "judge",
      text: t(state.continuityEnabled ? "blueprint.ctx.row.continuityOn" : "blueprint.ctx.row.continuityOff"),
      title: t("overview.continuityDesc"),
    },
  ];
}
