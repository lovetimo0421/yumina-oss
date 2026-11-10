import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import i18next from "i18next";
import { audioTypeLabel, describeSchemaChanges, fieldLabel, schemaChangeLabel, toolLabel } from "./change-labels";

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
const zh = i18n.getFixedT("zh") as never;

// Every kind an apply_changes batch can carry (server tool-executor SchemaChange).
const ENTITY_TYPES = ["entry", "variable", "rule", "behavior", "customUI", "audio", "sceneImage", "settings", "worldbook", "loreBinding", "uiKnobs", "uiKnobGroups", "uiDoc"];
// Every tool the assistant has (server studio-tools) plus the legacy ones a replay can show.
const TOOLS = [
  "write_entry", "write_variable", "write_behavior", "write_custom_ui", "edit_custom_ui", "write_ui_knob_groups", "set_ui_knobs",
  "write_audio", "write_scene_image", "write_worldbook", "write_lore_binding", "delete_entities", "apply_changes", "edit_ui_doc",
  "read_ui_doc", "read_entities", "read_entity", "grep_world", "validate_world", "update_settings", "load_skill", "list_assets",
  "browse_assets", "compile_tsx", "generate_image", "generate_images", "ask_user", "analyze_token_cost", "validate_ui_blueprint",
  "list_templates", "some_future_tool",
];
const lookup = (id: string) => (id === "v-gold" ? "金币" : id === "e-open" ? "开场" : undefined);

test("an apply_changes batch reads as plain words, not `create variable \"…\"`", () => {
  const text = describeSchemaChanges([
    { action: "create", entityType: "variable", id: "gold", data: { name: "金币" } },
    { action: "update", entityType: "entry", id: "e-open", data: { content: "…" } },
    { action: "delete", entityType: "behavior", id: "b-9" },
    { action: "update", entityType: "settings", data: { temperature: 0.8 } },
    { action: "update", entityType: "uiDoc", data: {} },
  ], zh, lookup);
  assert.equal(text, "新建变量「金币」 · 修改词条「开场」 · 删除了一个行为 · 改了设置 · 修改了一个玩家界面");
});

test("repeats fold, and a name the batch does not carry comes from the card", () => {
  const en = i18n.getFixedT("en") as never;
  assert.equal(
    describeSchemaChanges([{ action: "update", entityType: "variable", id: "v-gold" }, { action: "update", entityType: "variable", id: "v-gold" }], en, lookup),
    "Changed variable “金币” ×2",
  );
  assert.equal(schemaChangeLabel({ action: "create", entityType: "mystery" }, zh), "新建一个内容");
});

test("every locale labels every operation, kind, tool and field — none leaks code words", () => {
  const CODE = /\b(create|update|delete)\s+(entry|variable|rule|behavior|customUI|audio|sceneImage|settings|worldbook|loreBinding|uiKnobs|uiKnobGroups|uiDoc)\b|[a-z]+_[a-z_]+|studio\.entity|\{\{|customUI|sceneImage|loreBinding|uiKnob|uiDoc|v-gold|e-open|b-9/;
  for (const lng of LOCALES) {
    const t = i18n.getFixedT(lng) as never;
    const lines: string[] = [];
    for (const entityType of ENTITY_TYPES) {
      for (const action of ["create", "update", "delete"]) {
        lines.push(schemaChangeLabel({ action, entityType, id: "b-9" }, t));
        lines.push(schemaChangeLabel({ action, entityType, id: "v-gold", data: { name: "X" } }, t, lookup));
      }
    }
    for (const tool of TOOLS) lines.push(toolLabel(tool, t));
    for (const field of ["default_value", "defaultValue", "behavior_rules", "behaviorRules", "secondary_keywords", "always_send", "tsx_code", "max_fire_count", "cooldown_turns", "whatever_else"]) {
      lines.push(fieldLabel(field, t));
    }
    for (const type of ["bgm", "sfx", "ambient", undefined]) lines.push(audioTypeLabel(type, t));
    for (const line of lines) {
      assert.ok(line.trim().length > 0, `${lng}: empty label`);
      assert.doesNotMatch(line, CODE, `${lng}: ${line}`);
    }
  }
});

test("fields read the same whether the tool sent snake_case or camelCase", () => {
  assert.equal(fieldLabel("default_value", zh), "初始值");
  assert.equal(fieldLabel("defaultValue", zh), "初始值");
  assert.equal(fieldLabel("behaviorRules", zh), "变化规则");
  assert.equal(toolLabel("write_variable", zh), "写变量");
  assert.equal(toolLabel("some_future_tool", zh), "其他步骤");
});

test("every label the change cards ask for exists in every locale (a missing one prints its key)", () => {
  // `studio.entity.apply` / `studio.entity.changes` were missing everywhere, so
  // an apply_changes card headed itself with the raw key.
  const src = ["./entity-preview.tsx", "./proposal-card.tsx"]
    .map((f) => readFileSync(new URL(f, import.meta.url), "utf-8"))
    .join("\n");
  const keys = [...new Set([...src.matchAll(/"(studio\.(?:entity|proposal)\.[A-Za-z]+)"/g)].map((m) => m[1]!))];
  assert.ok(keys.includes("studio.entity.apply") && keys.includes("studio.entity.changes"));
  for (const lng of LOCALES) {
    const json = load(lng);
    for (const key of keys) {
      const parts = key.split(".");
      const leaf = parts.pop()!;
      const parent = parts.reduce<Record<string, unknown> | undefined>((o, k) => o?.[k] as Record<string, unknown> | undefined, json);
      assert.ok(parent && (leaf in parent || `${leaf}_one` in parent), `${lng}: ${key}`);
    }
  }
});
