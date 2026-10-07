import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { changeReviewTitle, type ReviewPart } from "./change-review";
import { ChangeReviewBody } from "./change-review-view";
import type { ToolCall } from "../lib/types";
import { buildReviewDiffTokens } from "../lib/review-diff";

/** A proposed change from the assistant, before and after, side by side.
 *  Shown wherever the creator asks to inspect a change: the canvas's drawer
 *  and the full editor's docked tab. */

type DesktopReviewPayload = {
  title: string;
  toolName: string;
  changed: string;
  original: string;
};

type ServerReviewPayload = DesktopReviewPayload & {
  source?: string;
  parts?: ReviewPart[];
};

export type StudioChangeReviewParams = {
  toolCall?: ToolCall;
  agentRunId?: string;
  worldId?: string | null;
};

function parseReviewToolArgs(toolCall: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formatReviewValue(value: unknown) {
  if (typeof value === "string") return value.trim() || "(empty)";
  if (value === undefined || value === null) return "(empty)";
  return JSON.stringify(value, null, 2);
}

function summarizeReviewEntity(entity: unknown) {
  if (!entity || typeof entity !== "object") return null;
  const record = entity as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["id", "name", "content", "description", "behaviorRules", "defaultValue", "type", "enabled", "section", "role"]) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return Object.keys(summary).length > 0 ? summary : record;
}

function findReviewEntity(args: Record<string, unknown>, collection: unknown[] | undefined) {
  const id = typeof args.id === "string" ? args.id : null;
  const name = typeof args.name === "string" ? args.name : null;
  return collection?.find((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return (id && record.id === id) || (name && record.name === name);
  });
}

function buildDesktopReviewPayload(toolCall: ToolCall, draftInput?: Record<string, unknown>): DesktopReviewPayload {
  const args = parseReviewToolArgs(toolCall);
  const draft = draftInput ?? useEditorStore.getState().worldDraft as unknown as Record<string, unknown>;
  const toolName = toolCall.function.name;
  const title = formatReviewValue(args.name ?? args.id ?? toolName);
  const noOriginal = "No existing version.";

  if (toolName === "write_entry") {
    const existing = findReviewEntity(args, draft.entries as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args.content ?? args),
      original: existing ? formatReviewValue((existing as Record<string, unknown>).content ?? summarizeReviewEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_variable") {
    const existing = findReviewEntity(args, draft.variables as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args.behaviorRules ?? args.description ?? args),
      original: existing ? formatReviewValue((existing as Record<string, unknown>).behaviorRules ?? summarizeReviewEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_behavior") {
    const existing = findReviewEntity(args, draft.reactions as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args),
      original: existing ? formatReviewValue(summarizeReviewEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_custom_ui") {
    const files = (draft.rootComponent as Record<string, unknown> | undefined)?.files as Record<string, string> | undefined;
    const id = typeof args.id === "string" ? args.id : "index.tsx";
    return {
      title: id,
      toolName,
      changed: formatReviewValue(args.tsxCode ?? args),
      original: files?.[id] ? formatReviewValue(files[id]) : noOriginal,
    };
  }

  if (toolName === "edit_custom_ui") {
    return {
      title,
      toolName,
      changed: formatReviewValue(args.new_code ?? args),
      original: formatReviewValue(args.old_code ?? noOriginal),
    };
  }

  if (toolName === "write_audio") {
    const existing = findReviewEntity(args, draft.audioTracks as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args),
      original: existing ? formatReviewValue(summarizeReviewEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "delete_entities") {
    const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
    const collections = [
      ...(draft.entries as unknown[] | undefined ?? []),
      ...(draft.variables as unknown[] | undefined ?? []),
      ...(draft.reactions as unknown[] | undefined ?? []),
      ...(draft.rules as unknown[] | undefined ?? []),
      ...(draft.audioTracks as unknown[] | undefined ?? []),
    ];
    const files = (draft.rootComponent as Record<string, unknown> | undefined)?.files as Record<string, string> | undefined;
    const originals = ids.map((id) => {
      const entity = collections.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === id);
      if (entity) return { id, original: summarizeReviewEntity(entity) };
      if (files?.[id]) return { id, original: files[id] };
      return { id, original: "Not found in current draft." };
    });
    return {
      title: ids.join(", ") || toolName,
      toolName,
      changed: "This action deletes the listed item(s).",
      original: formatReviewValue(originals),
    };
  }

  return {
    title,
    toolName,
    changed: formatReviewValue(args),
    original: noOriginal,
  };
}

function DesktopReviewDiff({
  original,
  changed,
}: {
  original: string;
  changed: string;
}) {
  const { t } = useTranslation("editor");
  const tokens = useMemo(() => buildReviewDiffTokens(original, changed), [changed, original]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px] font-semibold">
        <span className="inline-flex items-center gap-1 rounded-full bg-lime-400 px-2 py-1 font-semibold text-black">
          <span className="font-mono">+</span>
          {t("studio.proposal.added")}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-orange-300 px-2 py-1 font-semibold text-black">
          <span className="font-mono">-</span>
          {t("studio.proposal.deleted")}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-h-full whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-7 text-muted-foreground">
          {tokens.map((token, index) => (
            <span
              key={`${token.type}-${index}`}
              className={cn(
                token.type === "added" && "rounded-sm bg-lime-400 px-0.5 font-semibold text-black",
                token.type === "removed" && "rounded-sm bg-orange-300 px-0.5 font-semibold text-black line-through decoration-black/80",
              )}
            >
              {token.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function StudioChangeReviewPanel({ params = {} }: { params?: StudioChangeReviewParams }) {
  const { t } = useTranslation("editor");
  const currentDraft = useEditorStore(s => s.worldDraft);
  const { toolCall, agentRunId, worldId } = params;
  const apiBase = import.meta.env.VITE_API_URL || "";
  const expectsServerReview = !!worldId && !!agentRunId && !!toolCall?.id;
  // The answer is kept with the request it answers, so a stale one from an
  // earlier change can never show, and nothing needs resetting in the effect.
  const requestKey = expectsServerReview ? `${worldId}/${agentRunId}/${toolCall!.id}` : null;
  const [fetched, setFetched] = useState<{ key: string; review: ServerReviewPayload | null; error: string | null } | null>(null);
  const current = fetched && fetched.key === requestKey ? fetched : null;
  const serverReview = current?.review ?? null;
  const reviewError = current?.error ?? null;
  const loadingReview = requestKey !== null && !current;

  useEffect(() => {
    if (!requestKey || !worldId || !agentRunId || !toolCall?.id) return;
    let cancelled = false;
    const settle = (review: ServerReviewPayload | null, error: string | null) => {
      if (!cancelled) setFetched({ key: requestKey, review, error });
    };
    fetch(`${apiBase}/api/studio/${worldId}/agent/changes/${encodeURIComponent(agentRunId)}/${encodeURIComponent(toolCall.id)}`, {
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error("Change data unavailable");
        return res.json();
      })
      .then(({ data }) => {
        if (data && typeof data === "object") settle(data as ServerReviewPayload, null);
        else settle(null, t("studio.proposal.compareSnapshotMissing"));
      })
      .catch(() => settle(null, t("studio.proposal.compareSnapshotError")));

    return () => {
      cancelled = true;
    };
  }, [agentRunId, apiBase, requestKey, t, toolCall?.id, worldId]);

  const review = useMemo(() => {
    if (serverReview) return serverReview;
    if (expectsServerReview && !reviewError) return null;
    if (!toolCall) return null;
    return buildDesktopReviewPayload(
      toolCall,
      currentDraft as unknown as Record<string, unknown>,
    );
  }, [currentDraft, expectsServerReview, reviewError, serverReview, toolCall]);

  if (!toolCall || !review) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-muted-foreground">
        {expectsServerReview && !reviewError ? t("studio.proposal.compareLoading") : t("studio.proposal.compareUnavailable")}
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-muted/30 px-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
            {t("studio.proposal.compareTitle")}
          </div>
          <div className="truncate text-sm font-semibold text-foreground">
            {changeReviewTitle(toolCall, t as never, { parts: serverReview?.parts, draft: currentDraft as never })}
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {loadingReview
            ? t("studio.proposal.compareLoading")
            : serverReview
              ? t("studio.proposal.compareUsingSnapshot")
              : reviewError}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <ChangeReviewBody
          parts={serverReview?.parts}
          original={review.original}
          changed={review.changed}
          renderDiff={(original, changed) => <DesktopReviewDiff original={original} changed={changed} />}
        />
      </div>
    </section>
  );
}
