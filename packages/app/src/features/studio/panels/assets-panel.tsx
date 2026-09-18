import type { IDockviewPanelProps } from "dockview-react";
import { CardAssetsView } from "@/features/library/card-assets-view";

export function AssetsPanel(_props: IDockviewPanelProps) {
  return (
    <div className="h-full overflow-y-auto p-3">
      <CardAssetsView />
    </div>
  );
}
