import type { IDockviewPanelProps } from "dockview-react";
import { SceneImagesSection } from "@/features/editor/sections/scene-images";

export function SceneImagesPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <SceneImagesSection compact />
    </div>
  );
}
