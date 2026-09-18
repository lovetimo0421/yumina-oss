import "../src/styles/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { ComponentHost } from "./component-host";
import { initializeSandboxPlatformOverlay } from "./platform-overlay-root";

// Every world is v2 — the v1 SandboxHost + `#v2` URL-hash branch were deleted
// in the v1→v2 unification (phase 5). All worlds render through ComponentHost,
// which consumes a rootComponent's virtual filesystem.

const root = document.getElementById("sandbox-root");
if (root) {
  // Snapshot platform CSS before any creator component can inject global
  // styles, then keep platform-owned dialogs inside the isolated shadow layer.
  initializeSandboxPlatformOverlay();
  createRoot(root).render(
    <React.StrictMode>
      <ComponentHost />
    </React.StrictMode>
  );
}
