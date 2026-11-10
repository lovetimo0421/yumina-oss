import type { IDockviewPanelProps } from "dockview-react";
import { BackgroundsSection } from "@/features/editor/sections/backgrounds";

export function BackgroundsPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <BackgroundsSection />
    </div>
  );
}
