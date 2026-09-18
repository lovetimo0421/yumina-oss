import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { initializeSandboxPlatformOverlay } from "./platform-overlay-root";

export function SandboxPlatformOverlay({ children }: { children: ReactNode }) {
  const mount = initializeSandboxPlatformOverlay();
  return createPortal(
    <div className="yumina-platform-overlay-surface">{children}</div>,
    mount,
  );
}
