import type { IDockviewPanelProps } from "dockview-react";
import { VariablesSection } from "@/features/editor/sections/variables";

export function VariablesPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <VariablesSection compact />
    </div>
  );
}
