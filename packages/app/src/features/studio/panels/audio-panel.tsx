import type { IDockviewPanelProps } from "dockview-react";
import { AudioSection } from "@/features/editor/sections/audio";

export function AudioPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <AudioSection compact />
    </div>
  );
}
