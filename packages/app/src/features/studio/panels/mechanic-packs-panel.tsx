import type { IDockviewPanelProps } from "dockview-react";
import { MechanicPacksSection } from "@/features/editor/sections/mechanic-packs";

export function MechanicPacksPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <MechanicPacksSection />
    </div>
  );
}
