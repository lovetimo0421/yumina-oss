import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import i18next from "i18next";
import { describeUiDocOps } from "./ui-doc-op-labels";

const LOCALES = ["en", "es", "ja", "zh", "zh-Hant"] as const;
const load = (lng: string) => JSON.parse(readFileSync(new URL(`../../../locales/${lng}/editor.json`, import.meta.url), "utf-8"));

const i18n = i18next.createInstance();
await i18n.init({
  lng: "zh",
  fallbackLng: false,
  defaultNS: "editor",
  resources: Object.fromEntries(LOCALES.map((l) => [l, { editor: load(l) }])),
  interpolation: { escapeValue: false },
});

const ops = [
  { op: "update_part", id: "open-cards" },
  { op: "update_part", id: "open-sub" },
  { op: "add_part", part: { type: "text" } },
  { op: "add_part", part: { type: "meter" } },
  { op: "set_theme", preset: { id: "night" } },
  { op: "remove_part", id: "gone-already" },
];
const lookup = (id: string) =>
  id === "open-cards" ? { name: "开场卡片", type: "choice" }
  : id === "open-sub" ? { type: "text" }
  : undefined;

test("the change card says what changed in words, never the op names or ids", () => {
  const zh = describeUiDocOps(ops, i18n.getFixedT("zh") as never, lookup);
  assert.equal(zh, "改了「开场卡片」 · 改了「文字」 · 加了文字 · 加了状态条 · 配色和字体 · 删了一个部件");
});

test("every locale has every label, and none of them leaks tool vocabulary", () => {
  for (const lng of LOCALES) {
    const text = describeUiDocOps(
      [...ops, ...["add_page", "update_page", "rename_page", "remove_page", "set_entry_page", "detach_to_code", "reorder", "move_part", "apply_look", "mystery"].map((op) => ({ op, id: "open-sub" }))],
      i18n.getFixedT(lng) as never,
      lookup,
    );
    assert.doesNotMatch(text, /update_part|add_part|set_theme|remove_part|studio\.entity|open-cards|open-sub|gone-already|\{\{/, `${lng}: ${text}`);
  }
});

test("repeats fold into one line", () => {
  const en = describeUiDocOps([{ op: "update_part", id: "open-cards" }, { op: "update_part", id: "open-cards" }], i18n.getFixedT("en") as never, lookup);
  assert.equal(en, "Changed 开场卡片 ×2");
});
