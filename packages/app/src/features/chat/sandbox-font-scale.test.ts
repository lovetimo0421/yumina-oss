import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applySandboxFontScale, SANDBOX_FONT_SCALE_VAR } from "../../../sandbox/font-scale";

function fakeStyle() {
  const props = new Map<string, string>();
  return {
    fontSize: "",
    setProperty: (k: string, v: string) => { props.set(k, v); },
    removeProperty: (k: string) => { const v = props.get(k) ?? ""; props.delete(k); return v; },
    props,
  };
}

test("a bigger font size scales the sandbox root and hands card bubbles the same factor", () => {
  const style = fakeStyle();
  applySandboxFontScale(style as never, 1.25);
  assert.equal(style.fontSize, "20px");
  assert.equal(style.props.get(SANDBOX_FONT_SCALE_VAR), "1.25");
});

test("default size clears both, so a card at the default looks exactly as authored", () => {
  const style = fakeStyle();
  applySandboxFontScale(style as never, 1.75);
  applySandboxFontScale(style as never, 1);
  assert.equal(style.fontSize, "");
  assert.equal(style.props.has(SANDBOX_FONT_SCALE_VAR), false);
});

test("a junk scale is treated as the default", () => {
  const style = fakeStyle();
  applySandboxFontScale(style as never, Number.NaN);
  assert.equal(style.fontSize, "");
  assert.equal(style.props.has(SANDBOX_FONT_SCALE_VAR), false);
});

test("globals.css zooms the card bubble shell by the factor and undoes the inherited root scale", () => {
  const css = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf8");
  const block = css.match(/@supports \(zoom: 1\) \{\s*\.play-custom-component-shell \{([^}]*)\}/);
  assert.ok(block, "no zoom rule for .play-custom-component-shell");
  assert.match(block[1], /zoom:\s*var\(--yumina-font-scale,\s*1\)/);
  assert.match(block[1], /font-size:\s*calc\(100% \/ var\(--yumina-font-scale,\s*1\)\)/);
});
