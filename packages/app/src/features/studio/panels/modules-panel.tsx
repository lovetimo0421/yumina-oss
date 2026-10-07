import type { IDockviewPanelProps } from "dockview-react";
import { ModulesSection } from "@/features/editor/sections/modules";

export function ModulesPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <ModulesSection compact />
    </div>
  );
}
