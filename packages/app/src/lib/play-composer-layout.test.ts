import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalsCss = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
const toolMenuSource = readFileSync(
  new URL("../../sandbox/chat/composer-tool-menu.tsx", import.meta.url),
  "utf8",
);
const messageInputSource = readFileSync(
  new URL("../../sandbox/chat/message-input.tsx", import.meta.url),
  "utf8",
);

test("play zoom does not scale the composer chrome", () => {
  const composerRules = [...globalsCss.matchAll(/\.play-composer-inner\s*\{([^}]*)\}/g)];
  assert.ok(composerRules.length >= 2, "expected desktop and mobile composer rules");

  for (const [, declarations] of composerRules) {
    assert.doesNotMatch(declarations, /--play-ui-scale|\bzoom\s*:/);
  }

  assert.match(globalsCss, /width:\s*min\(100%,\s*var\(--play-surface-max\)\)/);
});

test("composer toolbar width is measured in unscaled layout coordinates", () => {
  assert.match(toolMenuSource, /apply\(el\.clientWidth\)/);
  assert.match(toolMenuSource, /apply\(e\.contentRect\.width\)/);
  assert.doesNotMatch(toolMenuSource, /getBoundingClientRect\(\)/);
});

test("the send controls cannot flex-shrink", () => {
  assert.match(messageInputSource, /play-composer-send-row flex shrink-0 items-center/);
});
