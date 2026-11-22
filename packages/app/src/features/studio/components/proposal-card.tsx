import { useState } from "react";
import {
  Wand2,
  Check,
  X,
  ChevronRight,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { EntityPreview, entityNameById } from "./entity-preview";
import type { ToolCall, ToolResult, ProposalStatus } from "../lib/types";
import { isReadTool } from "../lib/types";
import { toolLabel } from "./change-labels";
import { useEditorStore } from "@/stores/editor";

interface ProposalCardProps {
  toolCalls: ToolCall[];
  toolResults?: ToolResult[];
  status: ProposalStatus;
  onApprove?: () => void;
  onReject?: () => void;
  onInspectChange?: (toolCall: ToolCall) => void;
}

/** Batch approval card showing all proposed write tool calls. */
export function ProposalCard({ toolCalls, toolResults, status, onApprove, onReject, onInspectChange }: ProposalCardProps) {
  const { t } = useTranslation("editor");
  // A change that has landed is a line in the conversation, the way a
  // desktop agent says 「Edited charges.ts」: what it touched, a click away
  // from the detail. Only a change waiting for a yes opens as a card.
  const [expanded, setExpanded] = useState(status === "pending");

  // Filter to write tools only (read tools are auto-executed, don't show as proposals)
  const writeToolCalls = toolCalls.filter((tc) => !isReadTool(tc.function.name));
  if (writeToolCalls.length === 0) return null;

  const errorCount = toolResults?.filter((r) => r.status === "error").length ?? 0;
  const names = changeNames(writeToolCalls, (name) => toolLabel(name, t as unknown as Parameters<typeof toolLabel>[1]));
  const pending = status === "pending";

  return (
    <div
      className={cn(
        "mt-2 text-xs",
        pending && "rounded-xl border border-white/[0.08] bg-white/[0.035] p-2.5",
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={cn(
          "group flex w-full min-w-0 items-center gap-1.5 text-left",
          !pending && "-mx-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground",
        )}
      >
        {status === "approved" && (errorCount > 0
          ? <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400/80" />
          : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400/70" />)}
        {status === "rejected" && <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
        {pending && <Wand2 className="h-3.5 w-3.5 shrink-0 text-primary" />}
        <span className={cn("shrink-0", pending ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
          {pending
            ? (writeToolCalls.length === 1 ? t("studio.proposal.proposedChange", { count: 1 }) : t("studio.proposal.proposedChanges", { count: writeToolCalls.length }))
            : status === "approved" ? t("studio.proposal.applied") : t("studio.proposal.rejected")}
        </span>
        {/* What it touched, by the names the board uses. */}
        <span className={cn("min-w-0 truncate", pending ? "text-muted-foreground" : "text-foreground/75 group-hover:text-foreground")}>
          {names}
        </span>
        {status === "approved" && errorCount > 0 && (
          <span className="shrink-0 text-red-400/90">{errorCount === 1 ? t("studio.proposal.error", { count: 1 }) : t("studio.proposal.errors", { count: errorCount })}</span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-150",
            expanded && "rotate-90"
          )}
        />
      </button>

      {/* Tool call previews */}
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {writeToolCalls.map((tc, i) => (
            <div key={tc.id || i} className="space-y-0.5">
              <EntityPreview toolCall={tc} applied={status === "approved"} />
              {/* The compare view replays this card's history; a write to another
                  language version is not part of it. */}
              {onInspectChange && !writesVariant(tc) && (
                <button
                  type="button"
                  onClick={() => onInspectChange(tc)}
                  className="ml-auto flex rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground/80 transition-colors hover:bg-white/[0.05] hover:text-foreground"
                >
                  {t("studio.proposal.inspect")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Approval buttons (only when pending) */}
      {status === "pending" && onApprove && onReject && (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={onApprove}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 transition-opacity"
          >
            <Check className="h-3 w-3" />
            {t("studio.proposal.approve")}
          </button>
          <button
            onClick={onReject}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-white/[0.1] hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" />
            {t("studio.proposal.reject")}
          </button>
        </div>
      )}

      {/* Results (after approval, show errors) */}
      {status === "approved" && toolResults && errorCount > 0 && expanded && (
        <div className="mt-1.5 space-y-1">
          {toolResults
            .filter((r) => r.status === "error")
            .map((r, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10px] text-red-400">
                <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
                <span>
                  <strong>{toolLabel(r.name, t as unknown as Parameters<typeof toolLabel>[1])}:</strong> {r.error}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** What a batch touched, by name: 「Shopkeeper's Reputation、Night」. A write
 *  with no name of its own (an interface edit) is named by its tool. */
function changeNames(calls: ToolCall[], label: (tool: string) => string): string {
  const draft = useEditorStore.getState().worldDraft;
  const seen: string[] = [];
  for (const call of calls) {
    let args: Record<string, unknown> | undefined;
    try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { args = undefined; }
    const named = typeof args?.name === "string" && args.name.trim() ? args.name.trim() : entityNameById(draft, args?.id);
    const name = named || label(call.function.name);
    if (!seen.includes(name)) seen.push(name);
  }
  return seen.length > 3 ? `${seen.slice(0, 3).join("、")} +${seen.length - 3}` : seen.join("、");
}

function writesVariant(call: ToolCall): boolean {
  try { return typeof (JSON.parse(call.function.arguments) as Record<string, unknown>).variant === "string"; } catch { return false; }
}
