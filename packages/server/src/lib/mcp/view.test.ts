import { test } from "node:test";
import assert from "node:assert/strict";
import { VIEW_META, VIEW_TOOLS, VIEW_URI, viewHtml } from "./view.js";

test("the in-chat view is one self-contained page with the MCP Apps bridge as a global", () => {
  const html = viewHtml();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /globalThis\.McpApps=\{[^}]*"App":/, "the bridge's App is exposed to the page script");
  // The bundle's trailing ES export is gone (the page loads it as a classic script) and nothing closes a script early.
  const scripts = html.split("<script>").slice(1).map((s) => s.slice(0, s.indexOf("</script>")));
  assert.equal(scripts.length, 2);
  assert.ok(!/export\{[^}]*\}\s*;?\s*\}\)\(\);\s*$/.test(scripts[0]!), "no trailing export left");
  assert.ok(scripts.every((s) => !/<\/script/i.test(s)));
  // No network of its own: no external script or stylesheet.
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/i.test(html));
});

test("every tool drawn in the chat points at the same view", () => {
  assert.equal(VIEW_META.ui.resourceUri, VIEW_URI);
  assert.equal(VIEW_META["ui/resourceUri"], VIEW_URI);
  for (const name of ["generate_images", "generate_video", "wait_jobs", "playtest", "get_balance"]) assert.ok(VIEW_TOOLS.has(name), name);
});
