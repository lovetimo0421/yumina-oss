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

const modelPickerSource = readFileSync(
  new URL("../../sandbox/chat/model-picker-modal.tsx", import.meta.url),
  "utf8",
);

test("tight toolbars never hide the mushie balance", () => {
  // Regression (2026-09-29): <400px toolbars with the 提示词 button dropped the
  // balance tag, so phones and narrow custom-UI composers lost it entirely.
  assert.doesNotMatch(messageInputSource, /pillHidesBalance|showBalance=\{|PromptsToolbarButton/);
  assert.doesNotMatch(toolMenuSource, /hideBalance/);
  assert.match(messageInputSource, /<ModelTrigger onClick=\{openModelPicker\} compactBalance=\{isTight\} \/>/);
  assert.match(messageInputSource, /<ComposerToolMenu onOpenModelPicker=\{openModelPicker\} compactBalance=\{isTight\} \/>/);
  assert.match(toolMenuSource, /\{balance != null && <BalanceTag /);
});

test("in the model pill the name gives way, the balance and chevron do not", () => {
  // Name truncates but keeps a readable minimum; the balance tag is shrink-0.
  assert.match(modelPickerSource, /min-w-\[2\.5em\] truncate text-\[11px\] font-medium text-white\/75/);
  assert.match(toolMenuSource, /min-w-\[2\.5em\] truncate text-\[11px\] font-medium text-white\/75/);
  assert.match(modelPickerSource, /inline-flex shrink-0 items-center gap-0\.5 text-\[11px\] font-semibold text-\[#f3d361\]/);
  assert.match(modelPickerSource, /<ChevronRight className="h-3 w-3 shrink-0 text-white\/45/);
  // The full model name stays reachable while truncated.
  assert.match(modelPickerSource, /title=\{displayName\}/);
});
