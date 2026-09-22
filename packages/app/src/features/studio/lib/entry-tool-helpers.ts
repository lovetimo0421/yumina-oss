import type { Condition, WorldEntry } from "@yumina/engine";
import { deriveSectionDefaults } from "@yumina/engine";

export interface EntryToolArgs {
  id?: string;
  name?: string;
  content?: string;
  portrait?: string;
  role?: WorldEntry["role"];
  always_send?: boolean;
  keywords?: string[];
  conditions?: Array<{
    variable_id?: string;
    variableId?: string;
    operator: Condition["operator"];
    value: Condition["value"];
  }>;
  condition_logic?: WorldEntry["conditionLogic"];
  enabled?: boolean;
  depth?: number;
  match_whole_words?: boolean;
  secondary_keywords?: string[];
  secondary_keyword_logic?: WorldEntry["secondaryKeywordLogic"];
  prevent_recursion?: boolean;
  exclude_recursion?: boolean;
  section?: WorldEntry["section"];
  tags?: string[];
  folder_id?: string;
  position?: number;
  api_role?: WorldEntry["apiRole"];
}

/** Coerce array fields that an LLM tool call may emit as a string
 *  (e.g. `keywords: "a, b"` instead of `["a", "b"]`) into a clean string[]. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function mapEntryCondition(condition: NonNullable<EntryToolArgs["conditions"]>[number]): Condition {
  return {
    variableId: condition.variable_id ?? condition.variableId ?? "",
    operator: condition.operator,
    value: condition.value,
  };
}

export function mapEntryUpdates(args: EntryToolArgs): Partial<WorldEntry> {
  const updates: Partial<WorldEntry> = {};
  if (args.name !== undefined) updates.name = args.name;
  if (args.content !== undefined) updates.content = args.content;
  if (args.portrait !== undefined) updates.portrait = args.portrait;
  if (args.role !== undefined) updates.role = args.role;
  if (args.always_send !== undefined) updates.alwaysSend = args.always_send;
  if (args.keywords !== undefined) updates.keywords = toStringArray(args.keywords);
  if (args.conditions !== undefined) {
    updates.conditions = args.conditions.map(mapEntryCondition);
  }
  if (args.condition_logic !== undefined) updates.conditionLogic = args.condition_logic;
  if (args.enabled !== undefined) updates.enabled = args.enabled;
  if (args.depth !== undefined) updates.depth = args.depth;
  if (args.match_whole_words !== undefined) {
    updates.matchWholeWords = args.match_whole_words;
  }
  if (args.secondary_keywords !== undefined) {
    updates.secondaryKeywords = toStringArray(args.secondary_keywords);
  }
  if (args.secondary_keyword_logic !== undefined) {
    updates.secondaryKeywordLogic = args.secondary_keyword_logic;
  }
  if (args.prevent_recursion !== undefined) {
    updates.preventRecursion = args.prevent_recursion;
  }
  if (args.exclude_recursion !== undefined) {
    updates.excludeRecursion = args.exclude_recursion;
  }
  if (args.tags !== undefined) updates.tags = toStringArray(args.tags);
  if (args.folder_id !== undefined) updates.folderId = args.folder_id;
  if (args.position !== undefined) updates.position = args.position;
  if (args.api_role !== undefined) updates.apiRole = args.api_role;
  // When section changes, sync derived fields (alwaysSend, depth)
  if (args.section !== undefined) {
    updates.section = args.section;
    const defaults = deriveSectionDefaults(args.section as NonNullable<WorldEntry["section"]>);
    updates.alwaysSend = args.always_send ?? defaults.alwaysSend;
    if (defaults.depth !== undefined) updates.depth = defaults.depth;
  }
  // Variable-bound entries never use always-send — don't let a section change
  // resurrect it when the same call also sets conditions.
  if ((updates.conditions?.length ?? 0) > 0 && updates.alwaysSend && args.always_send === undefined) {
    updates.alwaysSend = false;
  }
  return updates;
}

export function buildCreatedEntry(baseEntry: WorldEntry, args: EntryToolArgs): WorldEntry {
  const section = args.section ?? "system-presets";
  const defaults = deriveSectionDefaults(section as NonNullable<WorldEntry["section"]>);

  const conditions = args.conditions?.map(mapEntryCondition) ?? [];
  return {
    ...baseEntry,
    id: args.id ?? baseEntry.id,
    name: args.name ?? "New Entry",
    content: args.content ?? "",
    portrait: args.portrait ?? baseEntry.portrait,
    role: args.role ?? "custom",
    // Variable-bound (condition-gated) entries never use always-send.
    alwaysSend: args.always_send ?? (conditions.length > 0 ? false : defaults.alwaysSend),
    keywords: toStringArray(args.keywords),
    conditions,
    conditionLogic: args.condition_logic ?? "all",
    enabled: args.enabled !== false,
    depth: args.depth ?? defaults.depth,
    matchWholeWords: args.match_whole_words ?? false,
    secondaryKeywords: toStringArray(args.secondary_keywords),
    secondaryKeywordLogic: args.secondary_keyword_logic ?? "AND_ANY",
    preventRecursion: args.prevent_recursion ?? false,
    excludeRecursion: args.exclude_recursion ?? false,
    section,
    tags: toStringArray(args.tags),
    folderId: args.folder_id,
    position: args.position ?? 0,
    apiRole: args.api_role,
  };
}
