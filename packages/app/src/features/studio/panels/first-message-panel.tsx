import type { IDockviewPanelProps } from "dockview-react";
import { FirstMessageSection } from "@/features/editor/sections/first-message";

export function FirstMessagePanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <FirstMessageSection compact />
    </div>
  );
}
