import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule } from "./feed-beacon.test-helpers";

test("one bounded close dwell excludes hidden time and StrictMode cleanup, and snapshots each preview", async t => {
  const path = new URL("./feed-beacon-visibility.ts", import.meta.url);
  assert.ok(existsSync(path), "foreground preview measurement must exist");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const env = clientDom();
  const { useFeedPreviewDwell } = loadClientModule<typeof import("./feed-beacon-visibility")>(path);
  const events: Array<{ identity: string; ms: number }> = [];
  const opens: string[] = [];
  function Preview({ identity }: { identity: string }) {
    useFeedPreviewDwell(identity, () => { opens.push(identity); }, ms => { events.push({ identity, ms }); });
    return null;
  }
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Preview, { identity: "page-one" }))));
    t.mock.timers.tick(0);
    assert.deepEqual(opens, ["page-one"]);
    assert.equal(events.length, 0, "strict replay is not a real close");
    now = 1000; env.visibility("hidden");
    now = 100_000; env.visibility("visible");
    now = 100_400;
    await act(async () => root.render(createElement(StrictMode, null, createElement(Preview, { identity: "page-two" }))));
    assert.deepEqual(events, [{ identity: "page-one", ms: 1400 }]);
    now += 60 * 60_000;
    await act(async () => root.render(null));
    t.mock.timers.tick(0);
    assert.deepEqual(events[1], { identity: "page-two", ms: 30 * 60_000 });
  } finally { await act(async () => root.unmount()); env.restore(); }
});
