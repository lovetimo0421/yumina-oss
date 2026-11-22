import { useReadingAppearance } from "./chat/reading-appearance";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { initializeSandboxPlatformOverlay } from "./platform-overlay-root";

export function SandboxPlatformOverlay({ children }: { children: ReactNode }) {
  const appearance = useReadingAppearance();
  const mount = initializeSandboxPlatformOverlay();
  return createPortal(
    <div {...appearance} className={`yumina-platform-overlay-surface ${appearance.className}`}>{children}</div>,
    mount,
  );
}
