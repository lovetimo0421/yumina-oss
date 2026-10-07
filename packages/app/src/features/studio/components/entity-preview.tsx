import { useState } from "react";
import {
  BookOpen,
  Variable,
  ScrollText,
  Code2,
  Music,
  Cog,
  Trash2,
  Pencil,
  Plus,
  ChevronDown,
  ChevronRight,
  Images,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction as I18nT } from "i18next";

type TFunction = I18nT<"editor">;
type Translate = (key: string | string[], opts?: Record<string, unknown>) => string;
import { useEditorStore } from "@/stores/editor";
import { describeUiDocOps, type PartLookup } from "./ui-doc-op-labels";
import { audioTypeLabel, describeSchemaChanges, fieldLabel, toolLabel, type EntityNameLookup } from "./change-labels";
import type { ToolCall } from "../lib/types";
import { toneBorder, toneText, toolKind } from "../lib/kind-tone";
import { cn } from "@/lib/utils";
import type { Reaction } from "@yumina/engine";
import { whenLabel } from "../lib/reaction-summary";

/** Compact inline preview of what a single tool call will do, with before/after diff for updates.
 *  Once the change is applied the draft already holds its result, so a diff
 *  against the draft would only list the change against itself. */
export function EntityPreview({ toolCall, applied = false }: { toolCall: ToolCall; applied?: boolean }) {
  const { t } = useTranslation("editor");
  const [expanded, setExpanded] = useState(false);
  const name = toolCall.function.name;
  let args: Record<string, unknown> = {};
  let parsed = true;
  try {
    const parsed: unknown = JSON.parse(toolCall.function.arguments);
    if (!isPreviewArgs(parsed)) throw new Error("Invalid preview arguments");
    args = parsed;
  } catch {
    parsed = false;
  }
  // A write that changes one field carries only the id; the creator knows the
  // thing by its name, not by a uuid. Read before any early return (hook order).
  const knownName = useEditorStore((s) => entityNameById(s.worldDraft, args.id));
  // An edit by id carries no role; the draft knows whether the entry is an opening.
  const knownRole = useEditorStore((s) => s.worldDraft.entries?.find((e) => e.id === args.id)?.role);
  // Interface edits name parts by id; the card names them as the layers list does.
  const uiDoc = useEditorStore((s) => s.worldDraft.uiDoc);
  const partLookup: PartLookup = (id) => {
    for (const page of uiDoc?.pages ?? []) {
      const el = page.elements.find((e) => e.id === id);
      if (el) return { name: el.name, type: el.type };
    }
    return undefined;
  };
  // A batch names its entities by id too; the card uses their names.
  const entityLookup: EntityNameLookup = (id) => entityNameById(useEditorStore.getState().worldDraft, id);
  if (!parsed) {
    return (
      // Usually the assistant tries the same step again and it lands; a
      // red line that outlived the retry read as "the card is broken".
      <div className="text-[10px] text-amber-300/70">
        {t("studio.entity.invalidArgs", { name: toolLabel(name, t as unknown as Translate) })}
      </div>
    );
  }

  const info = getToolInfo(name);
  const diff = useDiffInfo(name, args, t, applied);
  const fullContent = getFullContent(name, args, entityLookup);
  const isCode = name.includes("component") || name.includes("renderer") || name.includes("tsx") || name === "write_custom_ui";

  return (
    <div className={cn("rounded-md border bg-background/50", toneBorder(toolKind(name, { role: knownRole, ...args })))}>
      <div className="flex items-start gap-2 px-2.5 py-1.5">
        <div className="shrink-0 mt-0.5">
          <info.icon className={cn("h-3.5 w-3.5", toneText(toolKind(name, { role: knownRole, ...args })))} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`shrink-0 whitespace-nowrap text-[10px] font-semibold ${info.verbColor}`}>
              {t(info.verb as any)}
            </span>
            <span className="text-xs font-medium text-foreground truncate">
              {(args.name as string) || knownName || (info.category === name ? toolLabel(name, t as unknown as Translate) : t(info.category as any))}
            </span>
            {info.badge?.(args, t) && (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                {info.badge(args, t)}
              </span>
            )}
          </div>
          {/* Detail line (for creates) */}
          {info.detail && !diff && (
            <div className="text-[10px] text-muted-foreground/70 truncate mt-0.5">
              {info.detail(args, t, { part: partLookup, entity: entityLookup })}
            </div>
          )}
          {/* Diff lines (for updates/deletes) */}
          {diff && diff.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {diff.map((d, i) => (
                <div key={i} className="text-[10px] flex items-start gap-1">
                  <span className="text-muted-foreground/50 shrink-0 w-16 truncate">{d.label}:</span>
                  {d.type === "changed" && (
                    <span className="truncate">
                      <span className="text-red-400/70 line-through">{d.before}</span>
                      <span className="text-muted-foreground/40 mx-1">&rarr;</span>
                      <span className="text-emerald-400/80">{d.after}</span>
                    </span>
                  )}
                  {d.type === "added" && (
                    <span className="text-emerald-400/80 truncate">+ {d.after}</span>
                  )}
                  {d.type === "removed" && (
                    <span className="text-red-400/70 line-through truncate">{d.before}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Expand toggle */}
        {fullContent && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 mt-0.5 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title={expanded ? t("studio.entity.collapse") : t("studio.entity.viewFull")}
          >
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />
            }
          </button>
        )}
      </div>

      {/* Expanded full content */}
      {expanded && fullContent && (
        <div className="border-t border-border/30 px-2.5 py-2">
          {isCode ? (
            <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono leading-relaxed">
              {fullContent}
            </pre>
          ) : (
            <p className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words max-h-64 overflow-y-auto leading-relaxed">
              {fullContent}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Tool arguments are untrusted JSON, including when replaying saved runs. */
function isPreviewArgs(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const textFields = [
    "id", "name", "content", "tsxCode", "tsx_code", "new_code",
    "behaviorRules", "behavior_rules", "description", "type", "role",
    "section", "category", "language",
  ];
  if (textFields.some((key) => value[key] != null && typeof value[key] !== "string")) return false;
  for (const key of ["min", "max"]) {
    if (value[key] != null && typeof value[key] !== "number" && typeof value[key] !== "string") return false;
  }
  if (value.ids != null && (!Array.isArray(value.ids) || !value.ids.every((id) => typeof id === "string"))) return false;
  if (value.when != null && (!isRecord(value.when) || (value.when.eventType != null && typeof value.when.eventType !== "string"))) return false;
  for (const key of ["conditions", "then"]) {
    if (value[key] != null && !Array.isArray(value[key])) return false;
  }
  if (value.changes != null) {
    if (!Array.isArray(value.changes)) return false;
    if (!value.changes.every((change) => isRecord(change)
      && ["action", "entityType", "id"].every((key) => change[key] == null || typeof change[key] === "string")
      && (change.data == null || (isRecord(change.data) && (change.data.name == null || typeof change.data.name === "string"))))) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the primary content string to show when expanded. */
function getFullContent(name: string, args: Record<string, unknown>, lookup: EntityNameLookup): string | null {
  // Entry content
  if (name === "create_entry" || name === "update_entry") {
    const content = args.content as string | undefined;
    return content ?? null;
  }
  // Variable behavior rules / description
  if (name === "create_variable" || name === "update_variable") {
    const rules = args.behavior_rules as string | undefined;
    const desc = args.description as string | undefined;
    return rules ?? desc ?? null;
  }
  // TSX code
  if (name === "write_custom_component" || name === "write_message_renderer") {
    return (args.tsx_code as string) ?? null;
  }
  // Behaviors — show full JSON
  if (name === "create_behavior" || name === "update_behavior") {
    const { id: _id, ...rest } = args;
    return JSON.stringify(rest, null, 2);
  }
  // Rules — show full JSON
  if (name === "create_rule" || name === "update_rule") {
    const { id: _id, ...rest } = args;
    return JSON.stringify(rest, null, 2);
  }
  // Settings — show changed fields
  if (name === "update_settings") {
    return JSON.stringify(args, null, 2);
  }
  // write tools (camelCase params)
  if (name === "write_entry") return (args.content as string) ?? null;
  if (name === "write_variable") return (args.behaviorRules as string) ?? (args.description as string) ?? null;
  if (name === "write_custom_ui") return (args.tsxCode as string) ?? null;
  if (name === "write_behavior") { const { id: _id, ...rest } = args; return JSON.stringify(rest, null, 2); }
  if (name === "write_audio") return null;
  // Names, not ids: an id the creator never sees says nothing about what goes.
  if (name === "delete_entities") return (args.ids as string[] | undefined)?.map((id) => lookup(id) ?? id).join(", ") ?? null;
  return null;
}

// ── Diff computation ──

interface DiffLine {
  /** What the creator sees: the field's label, or the entity's name. */
  label: string;
  type: "changed" | "added" | "removed";
  before?: string;
  after?: string;
}

function entityNameById(draft: ReturnType<typeof useEditorStore.getState>["worldDraft"], id: unknown): string | undefined {
  if (typeof id !== "string" || !id) return undefined;
  const lists: Array<ReadonlyArray<{ id: string; name?: string }> | undefined> = [
    draft.entries, draft.variables, draft.reactions, draft.rules, draft.audioTracks, draft.sceneImages, draft.worldbooks,
  ];
  for (const list of lists) {
    const hit = list?.find((item) => item.id === id);
    if (hit?.name) return hit.name;
  }
  return undefined;
}

/** Look up the existing entity and compute field-level diffs for update/delete operations. */
function useDiffInfo(toolName: string, args: Record<string, unknown>, t: TFunction, applied: boolean): DiffLine[] | null {
  if (applied) return null;
  const draft = useEditorStore.getState().worldDraft;
  const id = args.id as string | undefined;
  if (!id) return null;

  // Compute diffs for update, delete, and write_* (upsert) operations
  const isUpdate = toolName.startsWith("update_");
  const isDelete = toolName.startsWith("delete_");
  const isWrite = toolName.startsWith("write_");
  if (!isUpdate && !isDelete && !isWrite) return null;

  // Find the existing entity
  let existing: Record<string, unknown> | null = null;
  if (toolName.includes("entry") || toolName === "write_entry") {
    existing = draft.entries.find((e) => e.id === id) as unknown as Record<string, unknown> ?? null;
  } else if (toolName.includes("variable") || toolName === "write_variable") {
    existing = draft.variables.find((v) => v.id === id) as unknown as Record<string, unknown> ?? null;
  } else if (toolName.includes("rule")) {
    existing = draft.rules.find((r) => r.id === id) as unknown as Record<string, unknown> ?? null;
  } else if (toolName.includes("behavior") || toolName === "write_behavior") {
    existing = (draft.reactions ?? []).find((r) => r.id === id) as unknown as Record<string, unknown> ?? null;
  } else if (toolName.includes("settings")) {
    existing = (draft.settings ?? {}) as Record<string, unknown>;
  } else if (toolName === "write_custom_ui" || toolName === "edit_custom_ui") {
    const files = draft.rootComponent?.files ?? {};
    const existingCode = files[id];
    existing = existingCode !== undefined
      ? { id, tsxCode: existingCode } as Record<string, unknown>
      : null;
  } else if (toolName === "write_audio") {
    existing = (draft.audioTracks ?? []).find((a) => a.id === id) as unknown as Record<string, unknown> ?? null;
  } else if (toolName === "write_scene_image") {
    existing = (draft.sceneImages ?? []).find((img) => img.id === id) as unknown as Record<string, unknown> ?? null;
  }

  // write_* tools are upserts — no diff for new entities
  if (isWrite && !existing) return null;

  if (!existing) {
    if (isDelete) return [{ label: t("studio.entity.entityCat"), type: "removed", before: t("studio.entity.willDelete") }];
    return null;
  }

  if (isDelete) {
    return [{ label: (existing.name as string) || t("studio.entity.entityCat"), type: "removed", before: t("studio.entity.willDelete") }];
  }

  // Compute field-level diffs for updates
  const diffs: DiffLine[] = [];
  const tr = t as unknown as Translate;
  const SKIP = new Set(["id", "position", "updatedAt", "order"]);
  // Map snake_case args to camelCase for comparison
  const SNAKE_TO_CAMEL: Record<string, string> = {
    always_send: "alwaysSend", condition_logic: "conditionLogic",
    match_whole_words: "matchWholeWords",
    secondary_keywords: "secondaryKeywords", secondary_keyword_logic: "secondaryKeywordLogic",
    prevent_recursion: "preventRecursion", exclude_recursion: "excludeRecursion",
    folder_id: "folderId", api_role: "apiRole", default_value: "defaultValue",
    behavior_rules: "behaviorRules", cooldown_turns: "cooldownTurns",
    max_fire_count: "maxFireCount", tsx_code: "tsxCode", event_type: "eventType",
    max_tokens: "maxTokens", max_context: "maxContext", top_p: "topP",
    frequency_penalty: "frequencyPenalty", presence_penalty: "presencePenalty",
    top_k: "topK", min_p: "minP", player_name: "playerName",
    full_screen_component: "fullScreenComponent", structured_output: "structuredOutput",
    lorebook_scan_depth: "lorebookScanDepth", lorebook_recursion_depth: "lorebookRecursionDepth",
  };

  for (const [key, newValue] of Object.entries(args)) {
    if (SKIP.has(key) || key === "id") continue;
    const camelKey = SNAKE_TO_CAMEL[key] ?? key;
    const oldValue = existing[camelKey];

    const oldStr = formatValue(oldValue, t);
    const newStr = formatValue(newValue, t);

    if (oldStr !== newStr) {
      if (oldValue === undefined || oldValue === null) {
        diffs.push({ label: fieldLabel(key, tr), type: "added", after: newStr });
      } else {
        diffs.push({ label: fieldLabel(key, tr), type: "changed", before: oldStr, after: newStr });
      }
    }
  }

  return diffs.length > 0 ? diffs.slice(0, 5) : null; // Cap at 5 diffs to avoid huge cards
}

function formatValue(value: unknown, t: TFunction): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncate(value, 60);
  if (typeof value === "boolean") return value ? t("studio.entity.yes") : t("studio.entity.no");
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return t("studio.entity.itemCount", { count: value.length });
  if (typeof value === "object") return truncate(JSON.stringify(value), 60);
  return String(value);
}

// ── Tool metadata ──

interface ToolInfo {
  verb: string;
  verbColor: string;
  category: string;
  icon: React.FC<{ className?: string }>;
  badge?: (args: Record<string, unknown>, t: TFunction) => string;
  detail?: (args: Record<string, unknown>, t: TFunction, ctx: { part: PartLookup; entity: EntityNameLookup }) => string;
}

function getToolInfo(name: string): ToolInfo {
  // Settings
  if (name === "update_settings")
    return { verb: "studio.entity.update", verbColor: "text-amber-400", category: "studio.entity.settings", icon: Cog };

  // Write tools (8-tool system — the agent's actual toolset)
  if (name === "write_entry")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.entry",
      icon: Plus,
      detail: (a) => truncate(a.content as string, 80),
    };
  if (name === "write_variable")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.variable",
      icon: Plus,
      // Type and range only: the category is agent metadata no editor shows.
      badge: (a, t) => {
        const parts = [a.type ? t(`variables.types.${a.type as string}`, { defaultValue: a.type as string }) : ""];
        if (a.min !== undefined || a.max !== undefined) parts.push(`${a.min ?? "—"} ~ ${a.max ?? "—"}`);
        return parts.filter(Boolean).join(" · ");
      },
      detail: (a) => (a.behaviorRules as string | undefined) ?? (a.description as string | undefined) ?? "",
    };
  if (name === "write_behavior")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.behavior",
      icon: Plus,
      // A threshold behaviour has no conditions — the line it watches IS
      // its trigger — and 「0 个条件」 read as a broken one. Say the trigger.
      detail: (a, t) => {
        const conditions = (a.conditions as unknown[] | undefined)?.length ?? 0;
        const effects = (a.then as unknown[] | undefined)?.length ?? 0;
        const when = a.when as Reaction["when"] | undefined;
        if (conditions === 0 && when?.eventType) {
          const variables = new Map((useEditorStore.getState().worldDraft.variables ?? []).map((v) => [v.id, v]));
          return t("studio.entity.behaviorWhen", { when: whenLabel({ when } as Reaction, variables, t("studio.entity.everyTurn")), effects });
        }
        return t("studio.entity.behaviorCounts", { conditions, effects });
      },
    };
  if (name === "write_custom_ui")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.customUI",
      icon: Code2,
      // The file name is the assistant's plumbing; the creator sees what it is.
      badge: (_a, t) => t("studio.entity.uiCode"),
      detail: (a) => truncate(a.tsxCode as string, 60),
    };
  if (name === "edit_custom_ui")
    return {
      verb: "studio.entity.edit",
      verbColor: "text-amber-400",
      category: "studio.entity.customUI",
      icon: Pencil,
      badge: (_a, t) => t("studio.entity.uiCode"),
      detail: (a) => truncate(a.new_code as string, 60),
    };
  if (name === "write_ui_knob_groups")
    return {
      verb: "studio.entity.write",
      verbColor: "text-amber-400",
      category: "studio.entity.customUI",
      icon: Code2,
      badge: (a, t) => {
        const groups = a.groups as Array<{ label?: string; knobs?: unknown[] }> | undefined;
        const knobs = groups?.reduce((n, g) => n + (g.knobs?.length ?? 0), 0) ?? 0;
        return t("studio.entity.knobGroups", { groups: groups?.length ?? 0, knobs });
      },
      detail: (a) => {
        const groups = a.groups as Array<{ label?: string; id?: string }> | undefined;
        return (groups ?? []).map((g) => g.label ?? g.id ?? "?").join(" · ");
      },
    };
  if (name === "write_audio")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.audio",
      icon: Music,
      badge: (a, t) => audioTypeLabel(a.type, t as unknown as Translate),
    };
  if (name === "write_scene_image")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.sceneImage",
      icon: Images,
      badge: (a) => (typeof a.name === "string" ? a.name : ""),
    };
  if (name === "delete_entities")
    return {
      verb: "studio.entity.delete",
      verbColor: "text-red-400",
      category: "studio.entity.entities",
      icon: Trash2,
      badge: (a, t) => t("studio.entity.entityCount", { count: (a.ids as string[] | undefined)?.length ?? 0 }),
    };

  // Legacy batch tool — kept for replay of historical agent runs
  if (name === "apply_changes")
    return {
      verb: "studio.entity.apply",
      verbColor: "text-emerald-400",
      category: "studio.entity.changes",
      icon: Plus,
      badge: (a) => {
        const changes = a.changes as Array<{ action: string; entityType: string }> | undefined;
        if (!changes?.length) return "";
        const creates = changes.filter((c) => c.action === "create").length;
        const updates = changes.filter((c) => c.action === "update").length;
        const deletes = changes.filter((c) => c.action === "delete").length;
        const parts: string[] = [];
        if (creates) parts.push(`+${creates}`);
        if (updates) parts.push(`~${updates}`);
        if (deletes) parts.push(`-${deletes}`);
        return parts.join(" ");
      },
      // 「新建变量「金币」 · 修改词条「开场」」, never `create variable "gold"`.
      detail: (a, t, ctx) => describeSchemaChanges(
        a.changes as Parameters<typeof describeSchemaChanges>[0],
        t as unknown as Translate,
        ctx.entity,
      ),
    };
  // The interface document: one call carries a list of edits to the screen,
  // so the card says how many and what kind rather than a single entity.
  if (name === "edit_ui_doc")
    return {
      verb: "studio.entity.edit",
      verbColor: "text-amber-400",
      category: "studio.entity.interfaceDoc",
      icon: Pencil,
      badge: (a, t) => t("studio.entity.uiDocOps", { count: (a.ops as unknown[] | undefined)?.length ?? 0 }),
      detail: (a, t, ctx) => describeUiDocOps(a.ops as Parameters<typeof describeUiDocOps>[0], t as unknown as Parameters<typeof describeUiDocOps>[1], ctx.part),
    };
  if (name === "read_ui_doc")
    return { verb: "studio.entity.read", verbColor: "text-blue-400", category: "studio.entity.interfaceDoc", icon: BookOpen };
  if (name === "read_entities")
    return { verb: "studio.entity.read", verbColor: "text-blue-400", category: "studio.entity.entities", icon: BookOpen };

  // Read tools (shouldn't appear in proposals)
  if (name === "read_entity")
    return { verb: "studio.entity.read", verbColor: "text-blue-400", category: "studio.entity.entityCat", icon: Variable };
  if (name === "compile_tsx")
    return { verb: "studio.entity.compile", verbColor: "text-blue-400", category: "studio.entity.tsx", icon: Code2 };
  if (name === "load_skill")
    return { verb: "studio.entity.load", verbColor: "text-blue-400", category: "studio.entity.skill", icon: BookOpen };
  return { verb: "studio.entity.call", verbColor: "text-muted-foreground", category: name, icon: ScrollText };
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return "";
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "..." : oneLine;
}
