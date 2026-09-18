import { useCallback, useEffect } from "react";
import { useUiStore } from "@/stores/ui";
import { isIOS } from "./use-touch-device";

/**
 * Combined immersive fullscreen: browser Fullscreen API + theater mode
 * (hides sidebar, header, and browser chrome).
 */
export function useImmersiveMode() {
  const theaterMode = useUiStore((s) => s.theaterMode);
  const toggleTheaterMode = useUiStore((s) => s.toggleTheaterMode);

  // While in theater mode, pin app-shell-root scroll to 0.
  // The browser's fullscreen API scrolls the root element to bring the
  // target into view, which offsets the entire layout. This listener
  // fires on every scroll event and immediately resets it.
  useEffect(() => {
    if (!theaterMode) return;

    const root = document.querySelector(".app-shell-root");
    if (!root) return;

    root.scrollTop = 0;

    const onScroll = () => {
      if (root.scrollTop !== 0) {
        root.scrollTop = 0;
      }
    };

    root.addEventListener("scroll", onScroll, { passive: false });
    return () => root.removeEventListener("scroll", onScroll);
  }, [theaterMode]);

  const toggle = useCallback(() => {
    const entering = !useUiStore.getState().theaterMode;
    toggleTheaterMode();

    if (entering) {
      // iOS Safari does not support requestFullscreen() on non-video elements.
      if (!isIOS()) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
      // Reset scroll when exiting theater mode
      const root = document.querySelector(".app-shell-root");
      if (root) root.scrollTop = 0;
    }
  }, [toggleTheaterMode]);

  return { isImmersive: theaterMode, toggle };
}
