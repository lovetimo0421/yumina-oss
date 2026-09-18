import type { IDockviewPanelProps } from "dockview-react";
import { OverviewSection } from "@/features/editor/sections/overview";

export function OverviewPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <OverviewSection />
    </div>
  );
}
