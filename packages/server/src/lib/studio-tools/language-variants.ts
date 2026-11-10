import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../../db/index.js";
import { worldPendingEdits, worlds } from "../../db/schema.js";
import type { ToolCall, ToolDefinition } from "../llm/types.js";
import { resolveWorkingSchema } from "../pending-edit.js";
import { parseToolArgs } from "./parse-tool-args.js";

/**
 * A card's other language versions, for the assistant working on one of them.
 *
 * Variants are separate worlds sharing `language_group_id`, each with its own
 * translated text. The assistant knows they exist (a short list in its
 * prompt) and reaches one only by naming it in a tool's `variant` argument.
 * Only the same creator's worlds in the same group are reachable: the list is
 * the whole of what `variant` can resolve to.
 */
export interface LanguageSibling {
  id: string;
  language: string | null;
  name: string;
  variantLabel: string | null;
  status: string;
  /** A published variant with a held edit: the working copy differs from live. */
  held: boolean;
}

export interface LanguageVariants {
  /** The current world's own language. */
  language: string | null;
  siblings: LanguageSibling[];
}

/** Tools that take `variant`: reads that look at one card, and every write. */
export const VARIANT_TOOL_NAMES = new Set([
  "read_entities", "grep_world", "read_ui_doc", "validate_world", "analyze_token_cost",
  "write_entry", "write_variable", "write_behavior", "write_custom_ui", "edit_custom_ui", "set_ui_knobs",
  "write_ui_knob_groups", "edit_ui_doc", "write_audio", "write_scene_image", "update_settings",
  "write_worldbook", "write_lore_binding", "write_note", "delete_entities",
]);

const VARIANT_PARAM = {
  type: "string",
  description: "Another language version of this card to work on instead: its language code (e.g. \"en\") or card id, from the language variants listed in your context. Omit for this card.",
};

/** The same tools, with the optional `variant` argument where it applies. */
export function withVariantParam(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    if (!VARIANT_TOOL_NAMES.has(tool.function.name)) return tool;
    const params = tool.function.parameters as { properties?: Record<string, unknown> };
    return { ...tool, function: { ...tool.function, parameters: { ...params, properties: { ...(params.properties ?? {}), variant: VARIANT_PARAM } } } };
  });
}

/** The current world's language and its same-creator siblings. Empty when the
 *  world is not the user's or belongs to no group. */
export async function listLanguageVariants(worldId: string, userId: string): Promise<LanguageVariants> {
  const [self] = await db.select({ language: worlds.language, group: worlds.languageGroupId })
    .from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId))).limit(1);
  if (!self?.group) return { language: self?.language ?? null, siblings: [] };
  const rows = await db.select({ id: worlds.id, language: worlds.language, name: worlds.name, variantLabel: worlds.variantLabel, status: worlds.status })
    .from(worlds)
    .where(and(eq(worlds.languageGroupId, self.group), eq(worlds.creatorId, userId), ne(worlds.id, worldId)))
    .orderBy(asc(worlds.language), asc(worlds.createdAt));
  const heldIds = rows.length === 0 ? new Set<string>() : new Set((await db.select({ worldId: worldPendingEdits.worldId })
    .from(worldPendingEdits).where(inArray(worldPendingEdits.worldId, rows.map((r) => r.id)))).map((r) => r.worldId));
  return {
    language: self.language,
    siblings: rows.map((r) => ({ ...r, held: r.status === "published" && heldIds.has(r.id) })),
  };
}

const sameLanguage = (a: string | null | undefined, b: string) => !!a && a.trim().toLowerCase() === b.toLowerCase();

/** How the model and the creator see a variant: its language, or its id when
 *  the group holds another version in that language (this card included). */
export function variantKey(sibling: LanguageSibling, variants: LanguageVariants): string {
  const lang = sibling.language?.trim();
  if (!lang) return sibling.id;
  const others = variants.siblings.filter((s) => sameLanguage(s.language, lang)).length - 1 + (sameLanguage(variants.language, lang) ? 1 : 0);
  return others > 0 ? sibling.id : lang;
}

export function variantArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>).variant;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export type VariantTarget = { kind: "current" } | { kind: "sibling"; sibling: LanguageSibling; key: string } | { kind: "error"; error: string };

/** Which world a `variant` argument names. Only the listed siblings resolve. */
export function resolveVariant(variants: LanguageVariants, currentId: string, variant: string | undefined): VariantTarget {
  if (!variant || variant === currentId) return { kind: "current" };
  const byId = variants.siblings.find((s) => s.id === variant);
  if (byId) return { kind: "sibling", sibling: byId, key: variantKey(byId, variants) };
  // This card's own language means this card; another version in it goes by id.
  if (sameLanguage(variants.language, variant)) return { kind: "current" };
  const byLanguage = variants.siblings.filter((s) => sameLanguage(s.language, variant));
  if (byLanguage.length === 1) return { kind: "sibling", sibling: byLanguage[0]!, key: variantKey(byLanguage[0]!, variants) };
  if (byLanguage.length > 1) {
    return { kind: "error", error: `This card has ${byLanguage.length} versions in "${variant}"; name one by id: ${byLanguage.map((s) => `${s.id}「${s.name}」`).join(", ")}.` };
  }
  if (variants.siblings.length === 0) return { kind: "error", error: `This card has no other language versions you can work on, so there is no "${variant}". Leave variant out.` };
  return { kind: "error", error: `"${variant}" is not a language version of this card. Its versions: ${variants.siblings.map((s) => `${variantKey(s, variants)}「${s.name}」`).join(", ")}. Leave variant out for this card.` };
}

/** One line naming a variant in results, e.g. `en「Name」 (id)`. */
export function variantLabel(target: { sibling: LanguageSibling; key: string }): string {
  return target.key === target.sibling.id ? `${target.sibling.id}「${target.sibling.name}」` : `${target.key}「${target.sibling.name}」 (${target.sibling.id})`;
}

export interface VariantWorld {
  world: WorldDefinition;
  /** The stored working copy `world` was read from, and its save token. */
  raw: Record<string, unknown>;
  updatedAt: number | null;
}

/** A sibling's working copy — the held edit of a published variant, else its
 *  schema — exactly as the Studio would load it. Ownership is checked again. */
export async function loadVariantWorld(siblingId: string, userId: string): Promise<VariantWorld> {
  const [row] = await db.select({ schema: worlds.schema, status: worlds.status, updatedAt: worlds.updatedAt })
    .from(worlds).where(and(eq(worlds.id, siblingId), eq(worlds.creatorId, userId))).limit(1);
  if (!row) throw new Error("That language version is no longer available.");
  const raw = await resolveWorkingSchema(siblingId, row.status, (row.schema ?? {}) as Record<string, unknown>);
  return { world: migrateWorldDefinition(raw as unknown as WorldDefinition), raw, updatedAt: row.updatedAt?.getTime() ?? null };
}

/** The call without its `variant` argument: write tools pass every other
 *  argument into the entity, and the variant is not part of it. */
export function withoutVariant<T extends Pick<ToolCall, "function">>(call: T): T {
  let args: Record<string, unknown>;
  try { args = parseToolArgs(call.function.arguments) as Record<string, unknown>; } catch { return call; }
  if (!args || typeof args !== "object" || !("variant" in args)) return call;
  const { variant: _variant, ...rest } = args;
  return { ...call, function: { ...call.function, arguments: JSON.stringify(rest) } };
}

/** The call with `variant` rewritten to the sibling's key, so the transcript and
 *  the change card name it the same way. */
export function withVariantKey<T extends Pick<ToolCall, "function">>(call: T, key: string): T {
  let args: Record<string, unknown>;
  try { args = parseToolArgs(call.function.arguments) as Record<string, unknown>; } catch { return call; }
  if (!args || typeof args !== "object" || args.variant === key) return call;
  return { ...call, function: { ...call.function, arguments: JSON.stringify({ ...args, variant: key }) } };
}

/** Whether a stored call carries a `variant` (it then targeted another world). */
export function hasVariantArg(call: Pick<ToolCall, "function">): boolean {
  try { return variantArg(parseToolArgs(call.function.arguments)) !== undefined; } catch { return false; }
}

/** The prompt block: which versions exist, and when to touch them. */
export function describeLanguageVariants(variants: LanguageVariants): string {
  if (variants.siblings.length === 0) return "";
  const lines = variants.siblings.map((s) => {
    const state = s.status === "published" ? (s.held ? "published, with held edits" : "published") : s.status;
    return `- ${variantKey(s, variants)}「${s.name}」${s.variantLabel ? ` [${s.variantLabel}]` : ""} id ${s.id} — ${state}`;
  });
  return [
    "",
    "## Language variants of this card",
    `This card${variants.language ? ` (${variants.language})` : ""} has other language versions: separate cards with the same design and translated text.`,
    ...lines,
    "Work on this card only, unless the creator's request needs the others (\"do this in every language\", \"what does the English version say\"). Then pass variant (language code or id) to read_entities, grep_world, read_ui_doc, validate_world or any write tool to read or change that version. Keep ids and structure aligned across versions, and write each version's text in its own language.",
  ].join("\n");
}
