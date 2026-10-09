import type { BlockKind } from "@yumina/engine";

/** One tutorial. See docs/development/learning.md.
 *
 *  The first three lessons are required: the canvas draws only the blocks
 *  a lesson is about (`stage`), each lesson brings the next block onto it,
 *  and the camera frames the block the lesson is on (`focus`) above the
 *  guide, which stays docked at the bottom of the canvas. Finishing them
 *  unlocks the rest — one lesson per subject, taken in any order, each
 *  bringing its own block onto the same three. */
export const LEARNING_RELEASE = "blueprint-tour-14";
export const LEARNING_PANEL_EVENT = "yumina:studio-learn-panel";
export const LEARNING_CANVAS_EVENT = "yumina:studio-learn-canvas";
export const LEARNING_TARGET_EVENT = "yumina:studio-learn-target";
export const LEARNING_CANCEL_EVENT = "yumina:studio-learn-cancel";
export const LEARNING_OPEN_EVENT = "yumina:studio-learn-open";
/** The guide asks the canvas to bring one flow node into view, at the
 *  current zoom, when a lesson's block is standing off screen. */
export const LEARNING_REVEAL_EVENT = "yumina:studio-learn-reveal";
/** The guide's sample object, opened for editing: an entry on its row, a
 *  variable or behaviour in the column. */
export const LEARNING_SHOW_EVENT = "yumina:studio-learn-show";
/** The guide moved to another step. A menu or popover a beat asked the
 *  learner to open closes: left open, its backdrop ate the next click. */
export const LEARNING_STEP_EVENT = "yumina:studio-learn-step";
/** The guide's card has nowhere clear to stand: the canvas slides left by
 *  `dx` screen pixels (a pan, never a zoom) so it fits beside its block. */
export const LEARNING_ROOM_EVENT = "yumina:studio-learn-room";

/** `required` lessons come first and in order; `more` unlock after them. */
export type LearningPart = "required" | "more";
export const LEARNING_PARTS: readonly LearningPart[] = ["required", "more"];

export const LEARNING_LESSONS = [
  // ── Required ── one block at a time. `stage` is what the canvas draws,
  // `focus` is what the camera frames — the block this lesson is about.
  { id: "opening", revision: 19, part: "required", panel: "first-message", stage: ["opening"], focus: ["opening"], canvasTarget: "opening" },
  { id: "setting", revision: 17, part: "required", panel: "lorebook", stage: ["opening", "lore"], focus: ["lore"], canvasTarget: "setting" },
  { id: "interface", revision: 16, part: "required", panel: "frontend", stage: ["opening", "lore", "frontend"], focus: ["frontend"] },
  // ── More ── each brings its own block onto the three the learner knows.
  { id: "state", revision: 17, part: "more", panel: "variables", stage: ["opening", "lore", "frontend", "state"], focus: ["state"] },
  { id: "behavior", revision: 13, part: "more", panel: "rules", stage: ["opening", "lore", "frontend", "state", "behavior"], focus: ["behavior"] },
  { id: "atmosphere", revision: 8, part: "more", panel: "audio", stage: ["opening", "lore", "frontend", "audio", "image"], focus: ["audio", "image"] },
  { id: "assistant", revision: 13, part: "more", panel: "ai-chat" },
  { id: "card", revision: 13, part: "more", panel: "overview" },
  { id: "knowledge", revision: 9, part: "more", panel: "lorebook", stage: ["opening", "lore", "frontend"], focus: ["lore"] },
  { id: "looks", revision: 10, part: "more", panel: "frontend", stage: ["opening", "lore", "frontend"], focus: ["frontend"] },
  { id: "modules", revision: 15, part: "more", panel: "modules" },
  { id: "ais", revision: 8, part: "more", panel: "modules" },
  { id: "canvas", revision: 13, part: "more", panel: "blueprint" },
  { id: "ship", revision: 14, part: "more", panel: "playtest" },
] as const satisfies readonly { id: string; revision: number; part: LearningPart; panel: string; stage?: readonly BlockKind[]; focus?: readonly BlockKind[]; canvasTarget?: string }[];

export type LearningLesson = typeof LEARNING_LESSONS[number];
export type LearningPanel = LearningLesson["panel"];
export type LearningStepId = LearningLesson["id"];
/** The block kinds a staged lesson leaves on the canvas. */
export type LearningStage = readonly BlockKind[];

export const lessonsOf = (part: LearningPart): readonly LearningLesson[] => LEARNING_LESSONS.filter(lesson => lesson.part === part);
export const lessonById = (id: string): LearningLesson | undefined => LEARNING_LESSONS.find(lesson => lesson.id === id);
export const lessonStage = (lesson: LearningLesson): LearningStage | null => "stage" in lesson ? lesson.stage : null;
/** The block kinds a staged lesson's camera frames; the whole stage otherwise. */
export const lessonFocus = (lesson: LearningLesson): LearningStage | null => "focus" in lesson ? lesson.focus : null;
/** Taken at all, whichever revision: a lesson rewritten since does not lock
 *  the rest again. */
export const lessonTaken = (progress: LearningProgress, lesson: LearningLesson) => (progress.completed[lesson.id] ?? 0) > 0;
export const requiredDone = (progress: LearningProgress) => lessonsOf("required").every(lesson => lessonTaken(progress, lesson));
/** The lesson to take next: the first required one not taken, then the
 *  first of the rest in catalogue order; null once everything is taken. */
export function nextLesson(progress: LearningProgress): LearningLesson | null {
  return LEARNING_LESSONS.find(lesson => !lessonTaken(progress, lesson)) ?? null;
}
export const lessonUnlocked = (progress: LearningProgress, lesson: LearningLesson) =>
  lesson.part === "required" ? lessonsOf("required").slice(0, lessonsOf("required").indexOf(lesson)).every(item => lessonTaken(progress, item)) : requiredDone(progress);

export interface LearningProgress {
  seenRelease?: string;
  completed: Record<string, number>;
  current?: string;
}
const memory = new Map<string, LearningProgress>();
const keyFor = (account: string) => `yumina-learning-v1:${account}`;
function normalizeProgress(saved: Record<string, unknown>): LearningProgress {
  const current = LEARNING_LESSONS.find(l => l.id === saved.current);
  const completed = (saved.completed ?? {}) as Record<string, unknown>;
  return {
    ...(typeof saved.seenRelease === "string" ? { seenRelease: saved.seenRelease } : {}),
    ...(current ? { current: current.id } : {}),
    completed: Object.fromEntries(LEARNING_LESSONS.filter(l => Number.isInteger(completed[l.id]) && (completed[l.id] as number) > 0).map(l => [l.id, completed[l.id] as number])),
  };
}
export function readLearningProgress(account: string, storage?: Pick<Storage, "getItem">): LearningProgress {
  if (memory.has(account)) return memory.get(account)!;
  try {
    const saved = JSON.parse((storage ?? localStorage).getItem(keyFor(account)) ?? "null");
    if (saved && typeof saved === "object") return normalizeProgress(saved);
  } catch { /* quota/private mode: retain progress for this page session */ }
  return memory.get(account) ?? { completed: {} };
}
export function writeLearningProgress(account: string, progress: LearningProgress, storage?: Pick<Storage, "setItem">) {
  memory.set(account, normalizeProgress(progress as unknown as Record<string, unknown>));
  try { (storage ?? localStorage).setItem(keyFor(account), JSON.stringify(progress)); } catch { /* session fallback */ }
}
export function lessonIsCurrent(progress: LearningProgress, lesson: LearningLesson): boolean {
  return (progress.completed[lesson.id] ?? 0) >= lesson.revision;
}
