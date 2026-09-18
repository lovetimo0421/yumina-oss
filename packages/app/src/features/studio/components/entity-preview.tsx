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
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import type { ToolCall } from "../lib/types";

/** Compact inline preview of what a single tool call will do, with before/after diff for updates. */
export function EntityPreview({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation("editor");
  const [expanded, setExpanded] = useState(false);
  const name = toolCall.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return (
      <div className="text-[10px] text-red-400">
        {t("studio.entity.invalidArgs", { name })}
      </div>
    );
  }

  const info = getToolInfo(name);
  const diff = useDiffInfo(name, args);
  const fullContent = getFullContent(name, args);
  const isCode = name.includes("component") || name.includes("renderer") || name.includes("tsx") || name === "write_custom_ui";

  return (
    <div className="rounded-md border border-border/40 bg-background/50">
      <div className="flex items-start gap-2 px-2.5 py-1.5">
        <div className="shrink-0 mt-0.5">
          <info.icon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-semibold ${info.verbColor}`}>
              {t(info.verb as any)}
            </span>
            <span className="text-xs font-medium text-foreground truncate">
              {(args.name as string) || (args.id as string) || t(info.category as any)}
            </span>
            {info.badge && (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                {info.badge(args)}
              </span>
            )}
          </div>
          {/* Detail line (for creates) */}
          {info.detail && !diff && (
            <div className="text-[10px] text-muted-foreground/70 truncate mt-0.5">
              {info.detail(args)}
            </div>
          )}
          {/* Diff lines (for updates/deletes) */}
          {diff && diff.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {diff.map((d, i) => (
                <div key={i} className="text-[10px] flex items-start gap-1">
                  <span className="text-muted-foreground/50 shrink-0 w-16 truncate">{d.field}:</span>
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

/** Extract the primary content string to show when expanded. */
function getFullContent(name: string, args: Record<string, unknown>): string | null {
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
  if (name === "delete_entities") return (args.ids as string[])?.join(", ") ?? null;
  return null;
}

// ── Diff computation ──

interface DiffLine {
  field: string;
  type: "changed" | "added" | "removed";
  before?: string;
  after?: string;
}

/** Look up the existing entity and compute field-level diffs for update/delete operations. */
function useDiffInfo(toolName: string, args: Record<string, unknown>): DiffLine[] | null {
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
  }

  // write_* tools are upserts — no diff for new entities
  if (isWrite && !existing) return null;

  if (!existing) {
    if (isDelete) return [{ field: id, type: "removed", before: "will be deleted" }];
    return null;
  }

  if (isDelete) {
    return [{ field: (existing.name as string) ?? id, type: "removed", before: "will be deleted" }];
  }

  // Compute field-level diffs for updates
  const diffs: DiffLine[] = [];
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

    const oldStr = formatValue(oldValue);
    const newStr = formatValue(newValue);

    if (oldStr !== newStr) {
      if (oldValue === undefined || oldValue === null) {
        diffs.push({ field: key, type: "added", after: newStr });
      } else {
        diffs.push({ field: key, type: "changed", before: oldStr, after: newStr });
      }
    }
  }

  return diffs.length > 0 ? diffs.slice(0, 5) : null; // Cap at 5 diffs to avoid huge cards
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncate(value, 60);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
  if (typeof value === "object") return truncate(JSON.stringify(value), 60);
  return String(value);
}

// ── Tool metadata ──

interface ToolInfo {
  verb: string;
  verbColor: string;
  category: string;
  icon: React.FC<{ className?: string }>;
  badge?: (args: Record<string, unknown>) => string;
  detail?: (args: Record<string, unknown>) => string;
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
      badge: (a) => `${a.role ?? a.section ?? "custom"}`,
      detail: (a) => truncate(a.content as string, 80),
    };
  if (name === "write_variable")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.variable",
      icon: Plus,
      badge: (a) => {
        const parts = [a.type as string];
        if (a.min !== undefined || a.max !== undefined) parts.push(`${a.min ?? "—"}..${a.max ?? "—"}`);
        if (a.category) parts.push(a.category as string);
        return parts.filter(Boolean).join(", ");
      },
      detail: (a) => (a.behaviorRules as string | undefined) ?? (a.description as string | undefined) ?? "",
    };
  if (name === "write_behavior")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.behavior",
      icon: Plus,
      badge: (a) => {
        const when = a.when as Record<string, unknown> | undefined;
        return `WHEN: ${when?.eventType ?? "state:changed"}`;
      },
      detail: (a) => {
        const then = a.then as unknown[] | undefined;
        return `${(a.conditions as unknown[])?.length ?? 0} conditions, ${then?.length ?? 0} effects`;
      },
    };
  if (name === "write_custom_ui")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.customUI",
      icon: Code2,
      badge: (a) => `${a.id ?? "index.tsx"}${a.language && a.language !== "tsx" ? ` · ${a.language}` : ""}`,
      detail: (a) => truncate(a.tsxCode as string, 60),
    };
  if (name === "edit_custom_ui")
    return {
      verb: "studio.entity.edit",
      verbColor: "text-amber-400",
      category: "studio.entity.customUI",
      icon: Pencil,
      badge: (a) => `${a.id ?? "index.tsx"}`,
      detail: (a) => truncate(a.new_code as string, 60),
    };
  if (name === "write_audio")
    return {
      verb: "studio.entity.write",
      verbColor: "text-emerald-400",
      category: "studio.entity.audio",
      icon: Music,
      badge: (a) => `${a.type ?? "bgm"}`,
    };
  if (name === "delete_entities")
    return {
      verb: "studio.entity.delete",
      verbColor: "text-red-400",
      category: "studio.entity.entities",
      icon: Trash2,
      badge: (a) => `${(a.ids as string[])?.length ?? 0} entities`,
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
      detail: (a) => {
        const changes = a.changes as Array<{ action: string; entityType: string; id?: string; data?: Record<string, unknown> }> | undefined;
        if (!changes?.length) return "";
        return changes
          .map((c) => `${c.action} ${c.entityType} "${c.id ?? c.data?.name ?? "?"}"`)
          .join(", ");
      },
    };
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
