import type { IDockviewPanelProps } from "dockview-react";
import { GenerationEditorSection as GenerationSection } from "@/edition/slots";

/** New-Studio dockview panel hosting the AI generation atelier. */
export function GenerationAtelierPanel(_props: IDockviewPanelProps) {
  return <GenerationSection />;
}
