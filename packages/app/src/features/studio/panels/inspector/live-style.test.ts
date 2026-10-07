import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { UiElement } from "@yumina/engine";
import { lookChanged, paintLive } from "./live-style";

const dom = new JSDOM("<div></div>");
const node = () => dom.window.document.createElement("div") as unknown as HTMLElement;
const text = (style: Record<string, unknown>, template = "雾港来信", extra: Record<string, unknown> = {}) =>
  ({ id: "t", type: "text", x: 0, y: 0, w: 100, h: 40, text: { template }, style, ...extra }) as unknown as UiElement;

test("a text part's look is written the way the compiler writes it", () => {
  const n = node();
  paintLive(n, text({ size: 32, desktopSize: 48, color: "#4c8fd0", letterSpacing: 2, lineHeight: 1.2, align: "center", italic: true }), "desktop");
  assert.equal(n.style.fontSize, "48px");
  assert.equal(n.style.color, "rgb(76, 143, 208)");
  assert.equal(n.style.letterSpacing, "2px");
  assert.equal(n.style.textAlign, "center");
  assert.equal(n.style.fontStyle, "italic");
  paintLive(n, text({ size: 32 }), "phone");
  assert.equal(n.style.fontSize, "32px");
});

test("plain words follow as they are typed; words with a variable wait for the compile", () => {
  const n = node();
  paintLive(n, text({}, "推门进去"), "phone");
  assert.equal(n.textContent, "推门进去");
  paintLive(n, text({}, "你好，{{玩家名字}}"), "phone");
  assert.equal(n.textContent, "推门进去");
});

test("opacity and rotation apply to any part", () => {
  const n = node();
  paintLive(n, { id: "b", type: "shape", x: 0, y: 0, w: 10, h: 10, opacity: 0.5, rotation: 15 } as unknown as UiElement, "phone");
  assert.equal(n.style.opacity, "0.5");
  assert.equal(n.style.transform, "rotate(15deg)");
});

test("only a part whose look changed is repainted", () => {
  const a = text({ size: 20 });
  assert.equal(lookChanged(a, a), false);
  assert.equal(lookChanged(a, { ...a, x: 50 } as UiElement), false, "a move is geometry, painted elsewhere");
  assert.equal(lookChanged(a, text({ size: 21 })), true);
  assert.equal(lookChanged(a, { ...a, opacity: 0.4 } as UiElement), true);
});

test("a box's and a button's paint follow too; an image fill waits for the compile", () => {
  const n = node();
  paintLive(n, { id: "b", type: "box", x: 0, y: 0, w: 10, h: 10, style: { fills: [{ kind: "color", color: "#112233" }], radius: 12, borderColor: "#fff", borderWidth: 2 } } as unknown as UiElement, "phone");
  assert.equal(n.style.background, "rgb(17, 34, 51)");
  assert.equal(n.style.borderRadius, "12px");
  assert.equal(n.style.border, "2px solid rgb(255, 255, 255)");
  const before = n.style.background;
  paintLive(n, { id: "b", type: "box", x: 0, y: 0, w: 10, h: 10, style: { fills: [{ kind: "image", src: "x" }] } } as unknown as UiElement, "phone");
  assert.equal(n.style.background, before);
  const btn = node();
  paintLive(btn, { id: "c", type: "button", x: 0, y: 0, w: 10, h: 10, label: { template: "推门" }, style: { textColor: "#000000", size: 18 } } as unknown as UiElement, "phone");
  assert.equal(btn.textContent, "推门");
  assert.equal(btn.style.fontSize, "18px");
  assert.equal(btn.style.color, "rgb(0, 0, 0)");
});
