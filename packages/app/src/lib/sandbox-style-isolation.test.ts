import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  rewriteSandboxRootSelectors,
  rewriteSandboxRootSelectorText,
  SANDBOX_WORLD_ROOT_SELECTOR,
} from "./sandbox-style-isolation";

const here = dirname(fileURLToPath(import.meta.url));

test("creator document selectors are scoped to the world root", () => {
  const css = `
    :root { --story-font: Georgia; }
    html, body, #sandbox-root { font-size: 10px; margin: 0; }
    @media (max-width: 600px) { body { font-family: serif; } }
    button { padding: 0; }
  `;
  const rewritten = rewriteSandboxRootSelectorText(css);

  assert.equal(rewritten.match(new RegExp(SANDBOX_WORLD_ROOT_SELECTOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length, 3);
  assert.doesNotMatch(rewritten, /(^|[{};])\s*(?::root|html|body|#sandbox-root)(?=\s*[,{}])/m);
  assert.match(rewritten, /button \{ padding: 0; \}/, "ordinary creator selectors stay intact inside the world");
});

test("platform styles are preserved while creator styles are scoped", () => {
  const makeStyle = (textContent: string, platform: boolean) => ({
    nodeType: 1,
    nodeName: "STYLE",
    textContent,
    hasAttribute: (name: string) => platform && name === "data-yumina-platform-style",
    querySelectorAll: () => [],
  });
  const platform = makeStyle("html { font-size: 16px; }", true);
  const creator = makeStyle("body { font-family: serif; }", false);

  rewriteSandboxRootSelectors(platform as unknown as ParentNode);
  rewriteSandboxRootSelectors(creator as unknown as ParentNode);

  assert.equal(platform.textContent, "html { font-size: 16px; }");
  assert.equal(creator.textContent, `${SANDBOX_WORLD_ROOT_SELECTOR} { font-family: serif; }`);
});

test("platform overlay snapshots only bootstrap styles into a shadow root", () => {
  const overlayRootSource = readFileSync(
    join(here, "../../sandbox/platform-overlay-root.ts"),
    "utf8",
  );
  const mainSource = readFileSync(join(here, "../../sandbox/main.tsx"), "utf8");

  assert.match(overlayRootSource, /attachShadow\(\{ mode: "open" \}\)/);
  assert.match(overlayRootSource, /doc\.head\.querySelectorAll[\s\S]*style, link\[rel=/);
  assert.match(overlayRootSource, /data-yumina-platform-style/);
  assert.match(overlayRootSource, /:host \{[\s\S]*all: initial !important/);
  assert.match(mainSource, /initializeSandboxPlatformOverlay\(\);/);
});
