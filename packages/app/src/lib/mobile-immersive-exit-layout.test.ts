import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getImmersiveExitLayout,
  getMobileExitActivation,
  MOBILE_EXIT_AUTO_COLLAPSE_MS,
  scheduleMobileExitAutoCollapse,
} from "../features/chat/immersive-exit-layout";

const chatViewSource = readFileSync(
  new URL("../features/chat/chat-view.tsx", import.meta.url),
  "utf8",
);
const worldRendererSource = readFileSync(
  new URL("../features/chat/world-renderer.tsx", import.meta.url),
  "utf8",
);
const sandboxHtmlSource = readFileSync(
  new URL("../../sandbox/index.html", import.meta.url),
  "utf8",
);

test("mobile immersive controls start expanded in the safe-area top-right corner", () => {
  const layout = getImmersiveExitLayout(true, false);

  assert.match(layout.shellClassName, /fixed/);
  assert.match(layout.shellClassName, /right-\[max/);
  assert.match(layout.shellClassName, /z-\[100\]/);
  assert.deepEqual(layout.shellStyle, {
    top: "env(safe-area-inset-top, 0px)",
  });
  assert.match(layout.exitButtonClassName, /h-11/);
  assert.match(layout.exitButtonClassName, /w-11/);
  assert.match(layout.systemFullscreenButtonClassName, /h-11/);
  assert.match(layout.systemFullscreenButtonClassName, /w-11/);
});

test("collapsed mobile controls become a larger but still narrow edge tab", () => {
  const layout = getImmersiveExitLayout(true, true);

  assert.match(layout.shellClassName, /right-\[env/);
  assert.match(layout.exitButtonClassName, /h-11/);
  assert.match(layout.exitButtonClassName, /w-8/);
  assert.match(layout.exitButtonClassName, /rounded-r-none/);
  assert.match(layout.exitButtonClassName, /opacity-75/);
  assert.doesNotMatch(layout.exitButtonClassName, /w-11/);
});

test("touch controls execute collapse, expand, and collapse again", () => {
  assert.equal(MOBILE_EXIT_AUTO_COLLAPSE_MS, 2000);
  let collapsed = false;
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const schedule = (callback: () => void, delayMs: number) => {
    scheduled.push({ callback, delayMs });
    return scheduled.length;
  };
  const armCollapse = () => scheduleMobileExitAutoCollapse(() => {
    collapsed = true;
  }, schedule);

  armCollapse();
  assert.equal(scheduled[0]?.delayMs, 2000);
  scheduled[0]?.callback();
  assert.equal(collapsed, true);
  assert.equal(getMobileExitActivation(true, collapsed), "expand");

  collapsed = false;
  armCollapse();
  assert.equal(scheduled[1]?.delayMs, 2000);
  scheduled[1]?.callback();
  assert.equal(collapsed, true);
});

test("activation exits only while the full control is visible", () => {
  assert.equal(getMobileExitActivation(true, true), "expand");
  assert.equal(getMobileExitActivation(true, false), "exit");
  assert.equal(getMobileExitActivation(false, true), "exit");

  assert.match(chatViewSource, /scheduleMobileExitAutoCollapse\(/);
  assert.match(chatViewSource, /getMobileExitActivation\(isTouch, exitCollapsed\) === "expand"/);
  assert.match(chatViewSource, /shouldOfferSystemFullscreen && !exitCollapsed/);
  assert.match(chatViewSource, /exitCollapsed \? [\s\S]*h-5 w-0\.5[\s\S]*: [\s\S]*<Minimize/);
});

test("desktop immersive exit keeps its hover-corner layout", () => {
  const layout = getImmersiveExitLayout(false, false);

  assert.match(layout.shellClassName, /right-4/);
  assert.match(layout.shellClassName, /top-4/);
  assert.match(layout.shellClassName, /z-\[100\]/);
  assert.equal(layout.shellStyle, undefined);
  assert.match(layout.exitButtonClassName, /absolute right-0 top-0/);
  assert.match(layout.systemFullscreenButtonClassName, /absolute right-12 top-0/);
});

test("option C removes the creator-owned inset contract", () => {
  assert.doesNotMatch(chatViewSource, /getImmersiveThemeCssVars|themeCssVars=/);
  assert.doesNotMatch(worldRendererSource, /themeCssVars\?:|pushTheme\(themeCssVars\)/);
  assert.doesNotMatch(sandboxHtmlSource, /--yumina-top-right-inset/);
});
