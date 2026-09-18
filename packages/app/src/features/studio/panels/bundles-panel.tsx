import type { IDockviewPanelProps } from "dockview-react";
import { BundlesSection } from "@/edition/slots";

export function BundlesPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <BundlesSection />
    </div>
  );
}
