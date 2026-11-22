import type { EditorSection } from "@/stores/editor";

/** The left nav's name for each part of a card. Anything else that names a
 *  part (who is where, in the collaborators' strip) reads it from here, so
 *  the two can't drift apart. */
export const SECTION_LABEL_KEYS: Record<EditorSection, string> = {
  "first-message": "sections.firstMessage",
  entries: "sections.lorebook",
  variables: "sections.variables",
  rules: "sections.behaviors",
  modules: "sections.modules",
  components: "sections.customUI",
  apps: "sections.apps",
  audio: "sections.audio",
  "scene-images": "sections.sceneImages",
  backgrounds: "sections.backgrounds",
  packs: "sections.packs",
  assets: "sections.assets",
  generation: "sections.aiGeneration",
  overview: "sections.overview",
  bundles: "sections.bundles",
};

export function isEditorSection(value: string): value is EditorSection {
  return Object.prototype.hasOwnProperty.call(SECTION_LABEL_KEYS, value);
}
