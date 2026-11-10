import type { IDockviewPanelProps } from "dockview-react";
import { OverviewSection } from "@/features/editor/sections/overview";
import type { CoverSettingsTarget } from "@/features/editor/lib/cover-settings-target";

export function OverviewPanel(_props: IDockviewPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <OverviewSection />
    </div>
  );
}

/** The same page, opened on its cover field (the publish dialog's 去设置封面). */
export function OverviewCoverPanel({ cover }: { cover: CoverSettingsTarget }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <OverviewSection focusCover={cover} />
    </div>
  );
}
