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
import { EntityPreview } from "./entity-preview";
import type { ToolCall, ToolResult, ProposalStatus } from "../lib/types";
import { isReadTool } from "../lib/types";

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
  const [expanded, setExpanded] = useState(true);

  // Filter to write tools only (read tools are auto-executed, don't show as proposals)
  const writeToolCalls = toolCalls.filter((tc) => !isReadTool(tc.function.name));
  if (writeToolCalls.length === 0) return null;

  const errorCount = toolResults?.filter((r) => r.status === "error").length ?? 0;

  return (
    <div
      className={cn(
        "mt-2 rounded-lg border p-2.5 text-xs",
        status === "pending" && "border-primary/30 bg-primary/5",
        status === "approved" && "border-emerald-500/20 bg-emerald-500/5",
        status === "rejected" && "border-red-500/20 bg-red-500/5"
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left"
      >
        <Wand2 className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="font-medium text-foreground">
          {writeToolCalls.length === 1 ? t("studio.proposal.proposedChange", { count: 1 }) : t("studio.proposal.proposedChanges", { count: writeToolCalls.length })}
        </span>
        {status === "approved" && (
          <span className="flex items-center gap-1 text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {t("studio.proposal.applied")}
            {errorCount > 0 && (
              <span className="text-red-400">{errorCount === 1 ? t("studio.proposal.error", { count: 1 }) : t("studio.proposal.errors", { count: errorCount })}</span>
            )}
          </span>
        )}
        {status === "rejected" && (
          <span className="flex items-center gap-1 text-red-400">
            <XCircle className="h-3 w-3" />
            {t("studio.proposal.rejected")}
          </span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto h-3 w-3 text-muted-foreground transition-transform duration-150",
            expanded && "rotate-90"
          )}
        />
      </button>

      {/* Tool call previews */}
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {writeToolCalls.map((tc, i) => (
            <div key={tc.id || i} className="space-y-1">
              <EntityPreview toolCall={tc} />
              {onInspectChange && (
                <button
                  type="button"
                  onClick={() => onInspectChange(tc)}
                  className="ml-auto flex rounded-md border border-border/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground transition hover:border-primary/60 hover:text-foreground"
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
        <div className="flex gap-2 mt-2.5 pt-2 border-t border-border/30">
          <button
            onClick={onApprove}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Check className="h-3 w-3" />
            {t("studio.proposal.approve")}
          </button>
          <button
            onClick={onReject}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" />
            {t("studio.proposal.reject")}
          </button>
        </div>
      )}

      {/* Results (after approval, show errors) */}
      {status === "approved" && toolResults && errorCount > 0 && expanded && (
        <div className="mt-2 pt-2 border-t border-border/30 space-y-1">
          {toolResults
            .filter((r) => r.status === "error")
            .map((r, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10px] text-red-400">
                <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
                <span>
                  <strong>{r.name}:</strong> {r.error}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
