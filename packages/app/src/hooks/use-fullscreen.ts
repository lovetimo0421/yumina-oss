import { useCallback, useEffect } from "react";
import { useUiStore } from "@/stores/ui";
import { useUserProfileStore } from "@/stores/user-profile";
import { isIOS, isTouchDevice } from "./use-touch-device";

type KeyboardLock = { lock(keys: string[]): Promise<void>; unlock(): void };
let escapeLockInstalled = false;

/** While the page is fullscreen, Chromium hands Escape to the page instead of
 *  leaving fullscreen (players hold Escape to leave, and the browser says so).
 *  Games keep Escape for their own menus; an Escape the card does not claim
 *  comes back through the sandbox as `leaveImmersive`. Elsewhere a no-op. */
function installFullscreenEscapeLock(): void {
  if (escapeLockInstalled) return;
  escapeLockInstalled = true;
  const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
  if (typeof keyboard?.lock !== "function" || typeof keyboard.unlock !== "function") return;
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) keyboard.lock!(["Escape"]).catch(() => {});
    else keyboard.unlock!();
  });
}

/**
 * Combined immersive fullscreen: browser Fullscreen API + theater mode
 * (hides sidebar, header, and browser chrome).
 */
export function useImmersiveMode() {
  const theaterMode = useUiStore((s) => s.theaterMode);
  const toggleTheaterMode = useUiStore((s) => s.toggleTheaterMode);
  const mobileAutoSystemFullscreen = useUserProfileStore(
    (s) => s.profile?.preferences?.mobileAutoSystemFullscreen === true,
  );

  useEffect(installFullscreenEscapeLock, []);

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
      //
      // A phone gets the in-app immersive layout only (the rule since 06/09,
      // which the play page's own entry kept but a card's 全屏 button and the
      // header's did not). The browser's full screen there is the player's own
      // pick, from the button the immersive layout offers: entering it brings
      // Chrome's "swipe from the edge to exit" notice, and on a game with
      // controls at the screen edge it keeps coming back (noxrift, 11/16).
      if (!isIOS() && (!isTouchDevice() || mobileAutoSystemFullscreen)) {
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
  }, [toggleTheaterMode, mobileAutoSystemFullscreen]);

  return { isImmersive: theaterMode, toggle };
}
