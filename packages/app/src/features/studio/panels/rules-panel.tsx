import type { IDockviewPanelProps } from "dockview-react";
import { BehaviorsSection } from "@/features/editor/sections/behaviors-section";

export function RulesPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <BehaviorsSection compact />
    </div>
  );
}
