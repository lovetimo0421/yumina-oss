import { Toaster as SonnerToaster } from "sonner";
import { createPortal } from "react-dom";
import { useAchievementMomentActive } from "@/edition/slots";

const BASE_BOTTOM_PX = 24;
const MOBILE_BOTTOM_PX = 16;
/** Height of the achievement moment plus its gap; the pill lifts above it. */
export const MOMENT_LIFT_PX = 96;

/**
 * Bottom-center, one pill visible at a time, no shell chrome: every pill is a
 * toast.custom(<Pill/>) from lib/feedback.tsx. Unconverted toast.success/error
 * calls (until Wave 7 of the sweep) render Sonner's default markup, which
 * styles/feedback.css paints as a pill too. Spec §4.
 */
export function Toaster() {
  const lift = useAchievementMomentActive() ? MOMENT_LIFT_PX : 0;
  // Feedback must remain available while a full-page mobile portal temporarily
  // hides the underlying app (including notification error and undo actions).
  return createPortal(
    <SonnerToaster
      theme="dark"
      position="bottom-center"
      visibleToasts={1}
      expand={false}
      closeButton={false}
      gap={8}
      offset={{ bottom: BASE_BOTTOM_PX + lift }}
      mobileOffset={{
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${MOBILE_BOTTOM_PX + lift}px)`,
        left: "12px",
        right: "12px",
      }}
      toastOptions={{ unstyled: true, classNames: { toast: "yp-toast-shell" } }}
    />,
    document.body,
  );
}
