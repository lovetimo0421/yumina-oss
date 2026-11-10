import type { BlockKind } from "@yumina/engine";
import type { LearningStage } from "./learning-catalog";

/** The kind of block a flow node draws, whatever node type draws it: a list
 *  block carries its Block, the writing nodes and the empty invitations name
 *  their kind directly. Frames, drop slots and anything else have no kind and
 *  leave the canvas with the rest during a staged lesson. */
export function flowNodeBlockKind(node: { type?: string; data?: Record<string, unknown> }): BlockKind | null {
  const data = node.data ?? {};
  if (node.type === "block") return (data.block as { kind?: BlockKind } | undefined)?.kind ?? null;
  if (node.type === "writing" || node.type === "starter") return data.kind === "opening" ? "opening" : data.kind === "setting" ? "lore" : null;
  return null;
}

/** During a 基础 lesson the canvas draws only what the lesson is about. */
export function learningStageHides(node: { type?: string; data?: Record<string, unknown> }, stage: LearningStage | null | undefined): boolean {
  if (!stage) return false;
  const kind = flowNodeBlockKind(node);
  return kind === null || !stage.includes(kind);
}
