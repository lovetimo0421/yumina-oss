/**
 * The assistant's tool vocabulary, in the creator's words.
 *
 * A change card used to print what the tool received — `create variable
 * "gold"`, `update entry "abc123"`, `default_value: 0 → 10`, `generating
 * write_variable` — which is the protocol, not something a creator reads.
 * Every operation, entity kind, tool and field now has a label in each
 * locale ("新建变量「金币」", "初始值"), and anything unknown falls back to a
 * generic word ("其他步骤", "设置项") rather than to the raw name. Same idea as
 * ui-doc-op-labels.ts, which does this for interface edits.
 */

type Translate = (key: string | string[], opts?: Record<string, unknown>) => string;

/** Finds the name the editor shows for an entity, by id. */
export type EntityNameLookup = (id: string, entityType?: string) => string | undefined;

const KINDS = new Set([
  "entry", "variable", "rule", "behavior", "customUI", "audio", "sceneImage", "settings",
  "worldbook", "loreBinding", "uiKnobs", "uiKnobGroups", "uiDoc",
]);

const TOOLS = new Set([
  "write_entry", "write_variable", "write_behavior", "write_custom_ui", "edit_custom_ui", "write_ui_knob_groups",
  "set_ui_knobs", "write_audio", "write_scene_image", "write_worldbook", "write_lore_binding", "delete_entities",
  "apply_changes", "edit_ui_doc", "read_ui_doc", "read_entities", "read_entity", "grep_world", "validate_world",
  "update_settings", "load_skill", "list_assets", "browse_assets", "compile_tsx", "generate_image", "generate_images",
  "ask_user", "analyze_token_cost", "validate_ui_blueprint", "list_templates",
]);

const FIELDS = new Set([
  "name", "content", "description", "keywords", "secondary_keywords", "type", "min", "max", "default_value",
  "behavior_rules", "category", "enabled", "section", "role", "position", "priority", "always_send", "conditions",
  "condition_logic", "then", "actions", "trigger", "event_type", "cooldown_turns", "max_fire_count", "tsx_code",
  "new_code", "old_code", "url", "volume", "loop", "tags", "folder_id", "match_whole_words", "prevent_recursion",
  "exclude_recursion", "model", "temperature", "max_tokens", "max_context", "player_name",
]);

const AUDIO_TYPES = new Set(["bgm", "sfx", "ambient"]);

/** `defaultValue` and `default_value` are the same field to a creator. */
const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** What one entity kind is called ("变量"). */
export function kindLabel(entityType: string | undefined, t: Translate): string {
  return t(`studio.entity.kind.${entityType && KINDS.has(entityType) ? entityType : "other"}`);
}

/** What a tool does, as a short phrase ("写变量"). Never the tool's own name. */
export function toolLabel(name: string | undefined, t: Translate): string {
  return t(`studio.entity.tool.${name && TOOLS.has(name) ? name : "other"}`);
}

/** A field of an entity as the editor labels it ("初始值" for default_value). */
export function fieldLabel(key: string, t: Translate): string {
  const k = snake(key);
  return t(`studio.entity.field.${FIELDS.has(k) ? k : "other"}`);
}

/** An audio track's type ("背景音乐" for bgm). */
export function audioTypeLabel(type: unknown, t: Translate): string {
  const k = typeof type === "string" && AUDIO_TYPES.has(type) ? type : "bgm";
  return t(`studio.entity.audioType.${k}`);
}

interface SchemaChangeLike {
  action?: string;
  entityType?: string;
  id?: string;
  data?: Record<string, unknown>;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** One change of an `apply_changes` batch: 「新建变量「金币」」. */
export function schemaChangeLabel(change: SchemaChangeLike, t: Translate, lookup?: EntityNameLookup): string {
  if (change.entityType === "settings") return t("studio.entity.change.settings");
  const action = change.action === "create" || change.action === "delete" ? change.action : "update";
  const kind = kindLabel(change.entityType, t);
  const name = text(change.data?.name) || text(change.data?.title) || text(change.data?.label)
    || (change.id ? text(lookup?.(change.id, change.entityType)) : "");
  return name
    ? t(`studio.entity.change.${action}`, { kind, name })
    : t(`studio.entity.change.${action}Unnamed`, { kind });
}

/** A whole batch, in order, with repeats folded ("修改了一个变量 ×2"). */
export function describeSchemaChanges(changes: readonly SchemaChangeLike[] | undefined, t: Translate, lookup?: EntityNameLookup): string {
  const counts = new Map<string, number>();
  for (const change of changes ?? []) {
    const label = schemaChangeLabel(change, t, lookup);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(" · ");
}
