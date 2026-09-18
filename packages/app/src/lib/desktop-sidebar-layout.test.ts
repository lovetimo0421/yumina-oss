import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getDesktopSidebarOffset } from "./desktop-sidebar-layout.js";

const appShellSource = readFileSync(
  new URL("../components/layout/app-shell.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../components/layout/sidebar.tsx", import.meta.url),
  "utf8",
);
const globalsSource = readFileSync(
  new URL("../styles/globals.css", import.meta.url),
  "utf8",
);
const coverCropSource = readFileSync(
  new URL("../features/editor/components/cover-crop-dialog.tsx", import.meta.url),
  "utf8",
);

test("the desktop sidebar remains visible while non-Discover content keeps a separation gap", () => {
  assert.equal(
    getDesktopSidebarOffset("/app/hub", false),
    "var(--sidebar-collapsed-width)",
  );
  assert.equal(
    getDesktopSidebarOffset("/app/library", false),
    "calc(var(--sidebar-collapsed-width) + var(--desktop-sidebar-content-gap))",
  );
  assert.equal(getDesktopSidebarOffset("/app/library", true), "0px");
  assert.match(
    appShellSource,
    /"--desktop-sidebar-offset": desktopSidebarOffset/,
  );
  assert.match(appShellSource, /<Sidebar \/>/);
  assert.match(coverCropSource, /md:left-\[var\(--desktop-sidebar-offset,0px\)\]/);
  assert.match(
    globalsSource,
    /--desktop-sidebar-content-gap: clamp\(0\.5rem, 0\.3rem \+ 0\.25vw, 0\.75rem\)/,
  );
});

test("the desktop rail has no auto-hide or hover-reveal behavior", () => {
  assert.match(sidebarSource, /<div className="desktop-sidebar-rail">/);
  assert.doesNotMatch(sidebarSource, /desktop-sidebar-rail--overlay/);
  assert.doesNotMatch(sidebarSource, /desktop-sidebar-edge-trigger/);
  assert.doesNotMatch(sidebarSource, /desktopNavOpen|desktopNavPinned/);
  assert.doesNotMatch(globalsSource, /desktop-sidebar-rail--overlay/);
});
