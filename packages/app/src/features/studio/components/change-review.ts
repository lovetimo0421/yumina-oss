/**
 * The 「对比」 view of an assistant change, in the creator's words.
 *
 * It used to be titled with whatever the tool received — a UUID
 * (「对比: 41ba879b-…」) or the tool's own name (「edit_ui_doc」) — and an
 * interface change was shown as a character diff of the document's JSON,
 * which is the protocol, not the card. The title now reads like the change
 * card does (「修改变量「好感度」」, 「把界面改成…」), and an interface change
 * is summarised as parts added / changed / removed, text before → after and
 * colour swatches; the JSON stays one click away.
 */
import type { UiDoc, UiElement } from "@yumina/engine";
import { describeSchemaChanges, schemaChangeLabel, toolLabel, type EntityNameLookup } from "./change-labels";
import { describeUiDocOps, type PartLookup } from "./ui-doc-op-labels";

type Translate = (key: string | string[], opts?: Record<string, unknown>) => string;

export interface ReviewPart {
  action: string;
  entityType: string;
  id?: string;
  name?: string;
  original: string;
  changed: string;
  uiDoc?: { before: UiDoc | null; after: UiDoc | null };
}

interface ToolCallLike { function: { name: string; arguments?: string } }

const TOOL_ENTITY: Record<string, string> = {
  write_entry: "entry", write_variable: "variable", write_behavior: "behavior", write_audio: "audio",
  write_scene_image: "sceneImage", write_worldbook: "worldbook", write_lore_binding: "loreBinding",
  write_custom_ui: "customUI", edit_custom_ui: "customUI", update_settings: "settings",
  write_ui_knob_groups: "uiKnobGroups", set_ui_knobs: "uiKnobs",
};

function parseArgs(toolCall: ToolCallLike): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type DraftLike = Partial<Record<"entries" | "variables" | "reactions" | "rules" | "audioTracks" | "worldbooks" | "sceneImages", unknown>> & { uiDoc?: UiDoc };

/** Names the editor shows, by id, from the card as it is now. */
export function draftLookups(draft: DraftLike | undefined): { entity: EntityNameLookup; part: PartLookup } {
  const collections = ["entries", "variables", "reactions", "rules", "audioTracks", "worldbooks", "sceneImages"] as const;
  const entity: EntityNameLookup = (id) => {
    for (const key of collections) {
      const list = draft?.[key];
      if (!Array.isArray(list)) continue;
      const hit = list.find((item) => item && typeof item === "object" && (item as { id?: unknown }).id === id) as { name?: unknown } | undefined;
      if (hit && typeof hit.name === "string" && hit.name.trim()) return hit.name.trim();
    }
    return undefined;
  };
  const part: PartLookup = (id) => {
    for (const page of draft?.uiDoc?.pages ?? []) {
      const el = page.elements.find((e) => e.id === id);
      if (el) return { name: el.name, type: el.type };
    }
    return undefined;
  };
  return { entity, part };
}

/**
 * The title of one change: what happened to what, in the creator's words.
 * Prefers the server's structured parts (they know create vs update and the
 * entity's real name); falls back to reading the tool call against the draft.
 */
export function changeReviewTitle(
  toolCall: ToolCallLike,
  t: Translate,
  opts: { parts?: ReviewPart[]; draft?: DraftLike } = {},
): string {
  const args = parseArgs(toolCall);
  const name = toolCall.function.name;
  const lookups = draftLookups(opts.draft);
  if (name === "edit_ui_doc") {
    const ops = Array.isArray(args.ops) ? (args.ops as Parameters<typeof describeUiDocOps>[0]) : [];
    return describeUiDocOps(ops, t, lookups.part) || t("studio.entity.kind.uiDoc");
  }
  const parts = opts.parts?.filter((p) => p.entityType !== "uiDoc") ?? [];
  if (parts.length > 0) {
    return describeSchemaChanges(parts.map((p) => ({ action: p.action, entityType: p.entityType, id: p.id, data: p.name ? { name: p.name } : undefined })), t, lookups.entity);
  }
  if (name === "delete_entities") {
    const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
    return describeSchemaChanges(ids.map((id) => ({ action: "delete", entityType: undefined, id })), t, lookups.entity) || toolLabel(name, t);
  }
  const entityType = TOOL_ENTITY[name];
  if (entityType) {
    const id = typeof args.id === "string" ? args.id : undefined;
    const exists = !!id && !!lookups.entity(id);
    return schemaChangeLabel({ action: exists ? "update" : "create", entityType, id, data: args }, t, lookups.entity);
  }
  return toolLabel(name, t);
}

// ── Interface changes, summarised ─────────────────────────────────────────

export type UiDocChangeItem =
  | { kind: "page-added" | "page-removed"; name: string }
  | { kind: "page-renamed"; from: string; to: string }
  | { kind: "part-added" | "part-removed"; name: string; text?: string }
  | { kind: "part-changed"; name: string; aspects: string[]; textBefore?: string; textAfter?: string }
  | { kind: "theme-preset"; from?: string; to?: string }
  | { kind: "theme-token"; token: string; before?: string; after?: string }
  | { kind: "theme-font" };

const POSITION = ["x", "y", "w", "h", "desktop", "rotate", "rotation", "z", "hidden", "only"];
const TEXT = ["text", "label", "title", "body", "buttonLabel", "placeholder"];
const STYLE = ["style", "messageStyle", "fit", "radius", "animation", "look", "css"];
const ACTIONS = ["actions", "confirm", "onChange"];
const BINDING = ["value", "min", "max", "src", "variableId", "options", "items", "source", "rules"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function textOf(el: UiElement): string | undefined {
  const record = el as unknown as Record<string, unknown>;
  for (const key of TEXT) {
    const value = record[key];
    if (value && typeof value === "object" && typeof (value as { template?: unknown }).template === "string") {
      const text = ((value as { template: string }).template).trim();
      if (text) return text;
    }
  }
  return undefined;
}

/** Everything that changed in the interface, in reading order: pages, then
 *  parts page by page, then the card-wide look. */
export function summarizeUiDocChange(before: UiDoc | null | undefined, after: UiDoc | null | undefined, kindName: (type: string) => string): UiDocChangeItem[] {
  const items: UiDocChangeItem[] = [];
  const beforePages = before?.pages ?? [];
  const afterPages = after?.pages ?? [];
  const partName = (el: UiElement) => el.name?.trim() || kindName(el.type);

  for (const page of afterPages) {
    const old = beforePages.find((p) => p.id === page.id);
    if (!old) items.push({ kind: "page-added", name: page.name || page.id });
    else if (old.name !== page.name) items.push({ kind: "page-renamed", from: old.name || old.id, to: page.name || page.id });
  }
  for (const page of beforePages) {
    if (!afterPages.some((p) => p.id === page.id)) items.push({ kind: "page-removed", name: page.name || page.id });
  }

  const beforeEls = new Map<string, UiElement>();
  for (const page of beforePages) for (const el of page.elements) beforeEls.set(el.id, el);
  const afterIds = new Set<string>();
  for (const page of afterPages) {
    for (const el of page.elements) {
      afterIds.add(el.id);
      const old = beforeEls.get(el.id);
      if (!old) {
        items.push({ kind: "part-added", name: partName(el), text: textOf(el) });
        continue;
      }
      if (same(old, el)) continue;
      const oldRec = old as unknown as Record<string, unknown>;
      const newRec = el as unknown as Record<string, unknown>;
      const changedKeys = [...new Set([...Object.keys(oldRec), ...Object.keys(newRec)])].filter((k) => !same(oldRec[k], newRec[k]));
      const aspects = new Set<string>();
      for (const key of changedKeys) {
        if (key === "name") aspects.add("name");
        else if (POSITION.includes(key)) aspects.add("position");
        else if (TEXT.includes(key)) aspects.add("text");
        else if (STYLE.includes(key)) aspects.add("style");
        else if (ACTIONS.includes(key)) aspects.add("actions");
        else if (BINDING.includes(key)) aspects.add("binding");
        else aspects.add("other");
      }
      const textBefore = textOf(old);
      const textAfter = textOf(el);
      items.push({
        kind: "part-changed",
        name: partName(el),
        aspects: [...aspects],
        ...(aspects.has("text") && textBefore !== textAfter ? { textBefore, textAfter } : {}),
      });
    }
  }
  for (const [id, el] of beforeEls) {
    if (!afterIds.has(id)) items.push({ kind: "part-removed", name: partName(el), text: textOf(el) });
  }

  const presetBefore = before?.theme?.preset?.id;
  const presetAfter = after?.theme?.preset?.id;
  if (presetBefore !== presetAfter) items.push({ kind: "theme-preset", from: presetBefore, to: presetAfter });
  const tokensBefore = before?.theme?.tokens ?? {};
  const tokensAfter = after?.theme?.tokens ?? {};
  const norm = (k: string) => (k.startsWith("--") ? k : `--${k}`);
  const keys = [...new Set([...Object.keys(tokensBefore), ...Object.keys(tokensAfter)].map(norm))].sort();
  const read = (tokens: Record<string, string>, key: string) => tokens[key] ?? tokens[key.slice(2)];
  let fontChanged = false;
  for (const key of keys) {
    const a = read(tokensBefore, key);
    const b = read(tokensAfter, key);
    if (a === b) continue;
    if (key === "--yc-font") { fontChanged = true; continue; }
    items.push({ kind: "theme-token", token: key, before: a, after: b });
  }
  if (fontChanged || !same(before?.theme?.fonts, after?.theme?.fonts)) items.push({ kind: "theme-font" });
  return items;
}

/** The label a theme token has in the editor ("对方气泡"), falling back to a
 *  generic word — never the token name. */
export function themeTokenLabel(token: string, t: Translate): string {
  return t([`studio.review.token.${token.replace(/^--yc-/, "")}`, "studio.review.token.other"]);
}

/** Whether a token's value is a colour a swatch can show. */
export const isSwatchColor = (value: string | undefined): boolean =>
  !!value && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|linear-gradient\(|radial-gradient\()/i.test(value.trim());
