import { useCallback, useLayoutEffect, useRef } from "react";

const ownsDocument = () => document.documentElement.getAttribute("data-mobile-page-scroll") === "settings-main";

/** The two desktop panes share one scrollport on phones. Keep the menu's place
 * when entering a section, and start the section above its first control. */
export function useSettingsDocumentScroll(showNav: boolean, section: string) {
  const navTop = useRef(0);
  const previous = useRef({ showNav, section });
  useLayoutEffect(() => {
    const changed = previous.current.showNav !== showNav || previous.current.section !== section;
    previous.current = { showNav, section };
    // Initial route/history restoration and desktop pane positions keep their
    // own ownership. Search-result focus scrolls to its target after this.
    if (changed && ownsDocument()) {
      window.scrollTo({ top: showNav ? navTop.current : 0, left: 0, behavior: "instant" });
    }
  }, [showNav, section]);
  return useCallback(() => {
    if (showNav && ownsDocument()) navTop.current = window.scrollY;
  }, [showNav]);
}
