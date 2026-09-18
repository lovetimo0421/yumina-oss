import { useLayoutEffect } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  LibraryDetailPanelDesktop,
  type LibraryDetailPanelProps,
} from "./library-detail-panel-desktop";
import { LibraryDetailPanelMobile } from "./library-detail-panel-mobile";

export type { LibraryDetailPanelProps } from "./library-detail-panel-desktop";

export function LibraryDetailPanel(props: LibraryDetailPanelProps) {
  const isMobileDetail = useMediaQuery("(max-width: 767px)");

  // A different story starts at its cover. Keep this in the stable parent:
  // swapping mobile/desktop markup on rotation must not reset the reading
  // position, and refreshing the same story must not reset it either.
  useLayoutEffect(() => {
    const detail = document.querySelector<HTMLElement>('[data-scroll-restoration-id="library-detail"]');
    detail?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    detail?.closest<HTMLElement>(".app-shell-main-mobile-scrollable")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [props.selectedItem.id]);

  return isMobileDetail
    ? <LibraryDetailPanelMobile {...props} />
    : <LibraryDetailPanelDesktop {...props} />;
}
