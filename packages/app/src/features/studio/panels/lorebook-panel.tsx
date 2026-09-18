import type { IDockviewPanelProps } from "dockview-react";
import { KnowledgeBasesSection } from "@/features/editor/sections/knowledge-bases";

export function LorebookPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <KnowledgeBasesSection compact />
    </div>
  );
}
