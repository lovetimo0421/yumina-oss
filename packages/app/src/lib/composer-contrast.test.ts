import { test } from "node:test";
import assert from "node:assert/strict";
import { composite, contrast, drawsBorder, inkFor, INK_ON_DARK, INK_ON_LIGHT, parseColor } from "./composer-contrast";

test("parseColor reads computed-style forms", () => {
  assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor("rgba(255, 255, 255, 0.86)"), { r: 255, g: 255, b: 255, a: 0.86 });
  assert.deepEqual(parseColor("rgb(10 20 30 / 50%)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor("transparent")!.a, 0);
  assert.equal(parseColor("color(srgb 1 1 1)"), null);
  const cream = parseColor("oklab(0.91317 0.000119716 0.0223672 / 0.7)")!;
  assert.ok(Math.abs(cream.r - 232) < 2 && Math.abs(cream.g - 226) < 2 && Math.abs(cream.b - 210) < 3);
  assert.equal(cream.a, 0.7);
  const white = parseColor("oklch(1 0 0)")!;
  assert.ok(white.r > 254 && white.g > 254 && white.b > 254);
});

test("composite blends translucent layers", () => {
  const c = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(c.a, 1);
  assert.ok(Math.abs(c.r - 127.5) < 0.01);
});

test("platform cream text on a white composer is unreadable; dark ink fixes it", () => {
  const cream = parseColor("#E8E2D2")!;
  const white86 = composite(parseColor("rgba(255,255,255,.86)")!, parseColor("#808080")!);
  assert.ok(contrast(cream, white86) < 2);
  assert.equal(inkFor(white86), INK_ON_LIGHT);
  assert.ok(contrast(parseColor(INK_ON_LIGHT)!, white86) >= 7);
  assert.equal(inkFor(parseColor("#121316")!), INK_ON_DARK);
});

test("drawsBorder ignores hairlines that are invisible", () => {
  assert.equal(drawsBorder("2px", "rgb(255, 47, 160)"), true);
  assert.equal(drawsBorder("0px", "rgb(255, 47, 160)"), false);
  assert.equal(drawsBorder("1px", "rgba(255, 255, 255, 0.12)"), false);
});
