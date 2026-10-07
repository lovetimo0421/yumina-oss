import assert from "node:assert/strict";
import test from "node:test";
import type { UiDoc } from "@yumina/engine";
import { changeReviewTitle, summarizeUiDocChange, themeTokenLabel } from "./change-review";

/** A stand-in translator that shows which key and values were used. */
const t = (key: string | string[], opts?: Record<string, unknown>) => {
  const k = Array.isArray(key) ? key[0]! : key;
  const vals = opts ? Object.entries(opts).filter(([n]) => n !== "defaultValue").map(([n, v]) => `${n}=${String(v)}`).join(",") : "";
  return vals ? `${k}(${vals})` : k;
};
const call = (name: string, args: unknown) => ({ function: { name, arguments: JSON.stringify(args) } });

test("titles name the entity and the operation, never a UUID or a tool name", () => {
  const draft = { variables: [{ id: "41ba879b-fa77-45a9-935c-367504ca8619", name: "好感度" }] };
  const title = changeReviewTitle(call("write_variable", { id: "41ba879b-fa77-45a9-935c-367504ca8619", max: 100 }), t, { draft });
  assert.match(title, /studio\.entity\.change\.update\(.*name=好感度/);
  assert.doesNotMatch(title, /41ba879b/);
  const created = changeReviewTitle(call("write_entry", { id: "e-new", name: "小橘" }), t, { draft });
  assert.match(created, /change\.create\(.*name=小橘/);
  const ui = changeReviewTitle(call("edit_ui_doc", { ops: [{ op: "set_theme", tokens: {} }] }), t, { draft });
  assert.equal(ui, "studio.entity.uiOp.setTheme");
  assert.doesNotMatch(ui, /edit_ui_doc/);
});

test("server parts decide create vs update and carry the name", () => {
  const title = changeReviewTitle(call("write_variable", { id: "x" }), t, { parts: [{ action: "update", entityType: "variable", id: "x", name: "金币", original: "", changed: "" }] });
  assert.match(title, /change\.update\(.*name=金币/);
});

const doc = (over: Partial<UiDoc> = {}): UiDoc => ({
  version: 1,
  pages: [{ id: "p1", name: "首页", elements: [
    { id: "t1", type: "text", name: "标题", x: 0, y: 0, w: 100, h: 20, text: { template: "欢迎" } },
    { id: "b1", type: "button", x: 0, y: 30, w: 100, h: 20, label: { template: "开始" } },
  ] }],
  ...over,
} as unknown as UiDoc);

test("a uiDoc change reads as parts and colours, not JSON", () => {
  const before = doc({ theme: { tokens: { "--yc-bg": "#120d14", "--yc-text": "#efe3ec" } } } as Partial<UiDoc>);
  const after = structuredClone(before) as UiDoc;
  (after.pages[0]!.elements[0] as unknown as { text: { template: string } }).text.template = "欢迎光临";
  after.pages[0]!.elements[0]!.x = 20;
  after.pages[0]!.elements.splice(1, 1);
  after.pages[0]!.elements.push({ id: "m1", type: "meter", x: 0, y: 60, w: 100, h: 8 } as never);
  after.theme = { tokens: { "--yc-bg": "#ffe4ef", "--yc-text": "#4a2436" } };
  const items = summarizeUiDocChange(before, after, (type) => `kind:${type}`);
  assert.deepEqual(items.find((i) => i.kind === "part-changed"), { kind: "part-changed", name: "标题", aspects: ["position", "text"], textBefore: "欢迎", textAfter: "欢迎光临" });
  assert.ok(items.some((i) => i.kind === "part-removed" && i.name === "kind:button" && i.text === "开始"));
  assert.ok(items.some((i) => i.kind === "part-added" && i.name === "kind:meter"));
  assert.deepEqual(items.filter((i) => i.kind === "theme-token").map((i) => (i as { token: string }).token), ["--yc-bg", "--yc-text"]);
  assert.equal(themeTokenLabel("--yc-bubble-bg", t), "studio.review.token.bubble-bg");
});
