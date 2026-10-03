import { isContinuityEnabled, isSceneImageJudgeOn, type SceneImage, type WorldDefinition } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";

/**
 * Who places a card's scene images, as the editor shows it.
 *
 *  - "judge": after each reply the continuity judge picks one by its "when to
 *    show" sentence and it lands at the end of that reply. The default, and
 *    the only one that does not depend on the player's model obeying a
 *    directive.
 *  - "narrator": the story model writes `[image: id]` itself, so a picture can
 *    sit between paragraphs — when the model bothers to.
 *
 * `locked` = the judge is off for the whole card (Overview), so the narrator
 * has the images whatever this card's image setting says.
 */
export type SceneImageMode = "judge" | "narrator";

export function sceneImageModeOf(world: Pick<WorldDefinition, "continuity">): { mode: SceneImageMode; locked: boolean } {
  if (!isContinuityEnabled(world)) return { mode: "narrator", locked: true };
  return { mode: isSceneImageJudgeOn(world) ? "judge" : "narrator", locked: false };
}

/** Whether an image can appear on its own: a picture, a "when" sentence, and
 *  not held back for manual use. The same bar in both modes. */
export function isSceneImageAuto(img: SceneImage): boolean {
  return img.allowAiControl !== false && Boolean(img.url.trim()) && Boolean(img.scene.trim());
}

export function useSceneImageMode() {
  const continuity = useEditorStore((s) => s.worldDraft.continuity);
  const updateContinuity = useEditorStore((s) => s.updateContinuity);
  const { mode, locked } = sceneImageModeOf({ continuity });
  const setMode = (next: SceneImageMode) => updateContinuity({ images: next === "narrator" ? false : undefined });
  return { mode, locked, setMode };
}
