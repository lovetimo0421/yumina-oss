import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertCircle, Brain, Check, FileText, Layers3, Loader2, Pencil, Pin, RefreshCw, Save, Settings2, Trash2, X } from "lucide-react";
import type { SessionMemoryPayload, SessionMemoryUsageSummary, SessionSummaryCompactionMetadata, SessionSummaryImplementation, SessionSummaryLanguage, SessionSummaryPayload } from "@yumina/shared";
import { SESSION_SUMMARY_LANGUAGES, SESSION_SUMMARY_LANGUAGE_ENDONYMS } from "@yumina/shared";
import { useYumina } from "../../sandbox-context";
import { pickLang } from "../../chat/i18n";
import { ModelPickerModal, ModelTrigger } from "../../chat/model-picker-modal";
import { SandboxPlatformOverlay } from "../../platform-overlay-portal";

const DEFAULT_CONTEXT_MODEL = "google/gemini-2.5-flash-lite";
// The zero-cost play model (see @yumina/shared YUMINA_MODELS "Yumina Free").
// Kept as a literal: the sandbox bundle avoids importing the full registry here.
const FREE_CONTEXT_MODEL = "openrouter/free";
const DEFAULT_SUMMARY_TRIGGER_TOKENS = 32_000;
// Minimums must sit BELOW the defaults (mirror server
// session-compaction-core.ts). When min === default, Apply silently clamped
// any lower value back to the default — indistinguishable from a reset.
const MIN_SUMMARY_TRIGGER_TOKENS = 8_000;
const MAX_SUMMARY_TRIGGER_TOKENS = 2_000_000;
const DEFAULT_SUMMARY_RECENT_TAIL_TOKENS = 12_000;
// Mirrors MAX_PINNED_MEMORY_CHARS on the server (session-memory-core.ts); the
// route rejects longer bodies with a generic 400, so cap it at the textarea.
const PINNED_MAX_CHARS = 6_000;
const MIN_SUMMARY_RECENT_TAIL_TOKENS = 4_000;
const MAX_SUMMARY_RECENT_TAIL_TOKENS = 2_000_000;

/** Legacy structured-memory shape (pre 2026-07): six labeled string arrays,
 *  parsed from strict LLM JSON. Mirrors the server's LEGACY_MEMORY_LABELS so a
 *  raw legacy row renders identically on both sides. */
const LEGACY_MEMORY_LABELS: Array<[key: string, label: string]> = [
  ["coreFacts", "Core facts"],
  ["relationshipChanges", "Relationship changes"],
  ["activeGoalsAndOpenThreads", "Active goals and open threads"],
  ["importantDecisionsAndPromises", "Important decisions and promises"],
  ["worldStateAndInventory", "World state and inventory"],
  ["currentRisksAndConstraints", "Current risks and constraints"],
];

/** Convert the legacy six-array structured memory to the labeled text format
 *  (identical to the server's convertLegacyMemoryToText). Returns "" when the
 *  object holds none of the legacy arrays. */
function legacyStructuredMemoryToText(record: Record<string, unknown>): string {
  const sections: string[] = [];
  for (const [key, label] of LEGACY_MEMORY_LABELS) {
    const raw = record[key];
    if (!Array.isArray(raw)) continue;
    const items = raw.map((item) => String(item ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (items.length === 0) continue;
    sections.push(`${label}:\n${items.map((item) => `- ${item}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

/**
 * Reduce any stored/received memory shape to plain text. The server's
 * normalizeSessionMemory already returns `{ text }` for the hosted app, so the
 * hot path here is just the `{ text }`/string unwrap. But this ALSO converts
 * the legacy structured shape directly, so old memory still renders (and can't
 * be silently blanked-then-overwritten on save) if a raw value ever reaches the
 * client un-normalized — e.g. a stale cached payload, or the future offline
 * (Tauri) build reading the DB without the server's normalization pass.
 */
function memoryToText(input: unknown): string {
  const source = input && typeof input === "object" && "memory" in input
    ? (input as { memory?: unknown }).memory
    : input;
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    return legacyStructuredMemoryToText(record);
  }
  return "";
}

/**
 * Cosmetic-only renderer for the read-only memory view. Section headings
 * (short lines ending with ":" or markdown "#"/"**" headings) get the old
 * card-title styling and bullets get dots — but this is pure presentation:
 * any line that doesn't match simply renders as plain text, so unlike the
 * old JSON pipeline nothing can ever fail to display.
 */
function MemoryTextView({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<{ type: "heading" | "bullet" | "text" | "blank"; content: string; key: number }> = lines.map((raw, index) => {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) return { type: "blank" as const, content: "", key: index };
    const mdHeading = /^#{1,4}\s+(.+?)[:：]?$/.exec(trimmed);
    if (mdHeading) return { type: "heading" as const, content: mdHeading[1]!, key: index };
    const boldHeading = /^\*\*(.+?)[:：]?\*\*[:：]?$/.exec(trimmed);
    if (boldHeading) return { type: "heading" as const, content: boldHeading[1]!, key: index };
    if (/[:：]$/.test(trimmed) && trimmed.length <= 60 && !/^[-*•]/.test(trimmed)) {
      return { type: "heading" as const, content: trimmed.replace(/[:：]$/, ""), key: index };
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) return { type: "bullet" as const, content: bullet[1]!, key: index };
    return { type: "text" as const, content: trimmed, key: index };
  });

  return (
    <div className="min-h-[200px] w-full rounded-xl border border-white/[0.08] bg-black/25 p-4">
      {blocks.map((block) => {
        if (block.type === "blank") return <div key={block.key} className="h-2" />;
        if (block.type === "heading") {
          return (
            <h3 key={block.key} className="mt-3 mb-1.5 text-xs font-bold uppercase tracking-wide text-white/75 first:mt-0">
              {block.content}
            </h3>
          );
        }
        if (block.type === "bullet") {
          return (
            <div key={block.key} className="mb-1.5 flex gap-2 text-xs leading-relaxed text-white/72">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-white/30" />
              <span className="whitespace-pre-wrap">{block.content}</span>
            </div>
          );
        }
        return (
          <p key={block.key} className="mb-1.5 whitespace-pre-wrap text-xs leading-relaxed text-white/72">
            {block.content}
          </p>
        );
      })}
    </div>
  );
}

interface SessionMemoryModalProps {
  open: boolean;
  onClose: () => void;
}

type ContextTab = "systems" | "memory" | "localdev" | "summaryception";

export function SessionMemoryModal({ open, onClose }: SessionMemoryModalProps) {
  const api = useYumina();
  const zh = pickLang(api.language) === "zh";
  const tt = (en: string, cn: string) => (zh ? cn : en);
  const formatSummaryJobError = (message: string): string => {
    switch (message) {
      case "Summary job timed out. Retry to reuse completed chunks.":
        return tt(message, "摘要生成超时。重试时会复用已完成的片段。");
      case "Summary worker stopped responding. Retry to reuse completed chunks.":
        return tt(message, "摘要生成任务已中断。重试时会复用已完成的片段。");
      case "Summary job is no longer active.":
      case "Summary job ownership changed.":
        return tt(message, "此摘要任务已停止或被替换，请刷新状态后重试。");
      case "A story summary is already updating. Wait for it to finish before retrying.":
        return tt(message, "剧情摘要正在更新，请等待完成后再重试。");
      default:
        return message;
    }
  };

  // Relative for the recent past (the panel polls, so these self-refresh),
  // absolute once it stops reading naturally. Full timestamps made every
  // status row look like a log line.
  const formatDate = (value: string | null): string => {
    if (!value) return tt("Not generated yet", "尚未生成");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const diff = Date.now() - date.getTime();
    if (diff >= 0 && diff < 60_000) return tt("just now", "刚刚");
    if (diff >= 0 && diff < 3_600_000) {
      const m = Math.floor(diff / 60_000);
      return tt(`${m} min ago`, `${m} 分钟前`);
    }
    if (diff >= 0 && diff < 86_400_000) {
      const h = Math.floor(diff / 3_600_000);
      return tt(`${h} h ago`, `${h} 小时前`);
    }
    return date.toLocaleString();
  };
  const formatTokenCount = (value: number | null | undefined): string =>
    typeof value === "number" ? value.toLocaleString() : tt("Unknown", "未知");
  const formatMushies = (value: number | null | undefined): string => {
    if (typeof value !== "number" || !Number.isFinite(value)) return tt("Unknown", "未知");
    return value.toLocaleString(undefined, {
      maximumFractionDigits: 1,
      minimumFractionDigits: value > 0 && value < 1 ? 1 : 0,
    });
  };

  const [payload, setPayload] = useState<SessionMemoryPayload | null>(null);
  const [summaryPayload, setSummaryPayload] = useState<SessionSummaryPayload | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [summaryModelDraft, setSummaryModelDraft] = useState("");
  const [summaryceptionModelDraft, setSummaryceptionModelDraft] = useState("");
  const [memoryIncludedDraft, setMemoryIncludedDraft] = useState(true);
  const [summaryIncludedDraft, setSummaryIncludedDraft] = useState(true);
  const [summaryceptionIncludedDraft, setSummaryceptionIncludedDraft] = useState(false);
  const [summaryTriggerDraft, setSummaryTriggerDraft] = useState(String(DEFAULT_SUMMARY_TRIGGER_TOKENS));
  const [summaryRecentTailDraft, setSummaryRecentTailDraft] = useState(String(DEFAULT_SUMMARY_RECENT_TAIL_TOKENS));
  // One language for all three summarizers — the server keeps a single
  // column, so whichever payload comes back last is still authoritative.
  const [languageDraft, setLanguageDraft] = useState<SessionSummaryLanguage>("auto");
  const [contextTab, setContextTab] = useState<ContextTab>("systems");
  // Read-only by default; the editable fields only appear after pressing Edit.
  const [editingMemory, setEditingMemory] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [resumingAutoCompaction, setResumingAutoCompaction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedSummaryError, setDismissedSummaryError] = useState<string | null>(null);
  const observedSummaryJob = useRef<SessionSummaryPayload["job"]>(null);
  const [memoryModelPickerOpen, setMemoryModelPickerOpen] = useState(false);
  const [summaryModelPickerOpen, setSummaryModelPickerOpen] = useState(false);
  const [summaryceptionModelPickerOpen, setSummaryceptionModelPickerOpen] = useState(false);
  const [lastCompaction, setLastCompaction] = useState<SessionSummaryCompactionMetadata | null>(null);
  const [lastCompactionImplementation, setLastCompactionImplementation] = useState<SessionSummaryImplementation | null>(null);
  // Editable draft of the memory text (shown only in edit mode).
  const [memoryDraft, setMemoryDraft] = useState("");
  // Player-pinned notes: the block the updater never rewrites.
  const [pinnedDraft, setPinnedDraft] = useState("");
  const [editingPinned, setEditingPinned] = useState(false);
  const [savingPinned, setSavingPinned] = useState(false);
  // Summaryception snippet editing.
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null);
  const [snippetDraft, setSnippetDraft] = useState("");
  const [savingSnippet, setSavingSnippet] = useState(false);

  const memoryText = memoryToText(payload?.memory);
  const hasAnyMemory = memoryText.trim().length > 0;
  const pinnedText = payload?.pinned ?? "";

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setDismissedSummaryError(null);
    setEditingMemory(false);
    setEditingSummary(false);
    setEditingPinned(false);
    Promise.all([api.getSessionMemory(), api.getSessionSummary()])
      .then(([memoryData, summaryData]) => {
        setPayload(memoryData);
        setSummaryPayload(summaryData);
        setMemoryDraft(memoryToText(memoryData.memory));
        setPinnedDraft(memoryData.pinned ?? "");
        setSummaryDraft(summaryData.summary ?? "");
        setModelDraft(memoryData.model || DEFAULT_CONTEXT_MODEL);
        setSummaryModelDraft(summaryData.model || DEFAULT_CONTEXT_MODEL);
        setSummaryceptionModelDraft(summaryData.summaryception.model || summaryData.model || DEFAULT_CONTEXT_MODEL);
        setMemoryIncludedDraft(memoryData.included ?? true);
        setSummaryIncludedDraft(summaryData.localdevIncluded ?? summaryData.included ?? true);
        setSummaryceptionIncludedDraft(summaryData.summaryceptionIncluded ?? false);
        setSummaryTriggerDraft(String(summaryData.triggerTokens ?? DEFAULT_SUMMARY_TRIGGER_TOKENS));
        setSummaryRecentTailDraft(String(summaryData.recentTailTokens ?? DEFAULT_SUMMARY_RECENT_TAIL_TOKENS));
        setLanguageDraft(summaryData.language ?? memoryData.language ?? "auto");
      })
      .catch((err) => setError(err instanceof Error ? err.message : tt("Failed to load the memory panel", "加载记忆面板失败")))
      .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving a tab discards any in-progress edit on it (back to read-only).
  useEffect(() => {
    setEditingMemory(false);
    setEditingSummary(false);
    setEditingPinned(false);
  }, [contextTab]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (memoryModelPickerOpen || summaryModelPickerOpen || summaryceptionModelPickerOpen) return;
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [memoryModelPickerOpen, open, onClose, summaryModelPickerOpen, summaryceptionModelPickerOpen]);

  // ── Live status refresh ──────────────────────────────────────────────
  // Memory + summary status is tracked server-side and flips updating→idle in
  // background jobs (scheduleStoryCompaction / scheduleSessionMemoryIncremental
  // -Update fire on every completed turn, plus revert/fork regen). The modal
  // otherwise reads them only once on open, so a job that finished while the
  // modal stayed open kept showing a stale "updating" — and the old summary
  // text — until the user closed and reopened it. Poll while open so the status
  // and the finished summary settle on their own. Paused while the user is
  // editing or a local action is in flight, so a poll never clobbers a draft.
  const summaryJobActive = summaryPayload?.job?.status === "queued" || summaryPayload?.job?.status === "running";
  const anyUpdating = summaryJobActive ||
    payload?.status === "updating" ||
    summaryPayload?.status === "updating" ||
    summaryPayload?.summaryception.status === "updating";

  useEffect(() => {
    if (!open) return;
    if (editingMemory || editingSummary || editingSnippetId || editingPinned) return;
    if (saving || regenerating || compacting || savingPinned || resumingAutoCompaction) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [memoryData, summaryData] = await Promise.all([
          api.getSessionMemory(),
          api.getSessionSummary(),
        ]);
        if (cancelled) return;
        setPayload(memoryData);
        setSummaryPayload(summaryData);
        const previousJob = observedSummaryJob.current;
        const job = summaryData.job;
        if (previousJob?.id === job?.id && (previousJob?.status === "queued" || previousJob?.status === "running")) {
          if (job?.status === "completed") api.showToast(tt("Story summary regenerated", "剧情摘要已重新生成"), "success");
          if (job?.status === "failed") api.showToast(formatSummaryJobError(job.error || tt("Summary generation failed", "摘要生成失败")), "error");
        }
        observedSummaryJob.current = job;
        if (job) setError(previous => previous?.includes("regenerateSessionSummary") ? null : previous);
        // The read-only summary view renders summaryDraft (not
        // summaryPayload.summary), so sync it too — otherwise a finished
        // summary's text wouldn't appear. Safe: polling is paused above
        // whenever the summary is being edited.
        setSummaryDraft(summaryData.summary ?? "");
      } catch {
        // Swallow transient poll errors; the initial load already succeeded
        // and the next tick retries. Don't surface them as the panel error.
      }
    };
    // Snappy while a job is mid-flight; light heartbeat otherwise so a job that
    // begins right after open is still picked up without constant refetching.
    const id = setInterval(poll, anyUpdating ? 1500 : 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, anyUpdating, editingMemory, editingSummary, editingSnippetId, editingPinned, saving, regenerating, compacting, savingPinned, resumingAutoCompaction]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const refreshFromPayload = (data: SessionMemoryPayload) => {
    setPayload(data);
    // Never clobber a draft the user is still typing in: saving pinned notes
    // while the memory editor is open (or the reverse) refreshes the payload
    // but must leave the other editor's text alone.
    if (!editingMemory) setMemoryDraft(memoryToText(data.memory));
    if (!editingPinned) setPinnedDraft(data.pinned ?? "");
    setModelDraft(data.model || modelDraft);
    setMemoryIncludedDraft(data.included ?? true);
    setLanguageDraft(data.language ?? "auto");
  };

  const refreshFromSummaryPayload = (data: SessionSummaryPayload) => {
    setSummaryPayload(data);
    setSummaryDraft(data.summary ?? "");
    setSummaryModelDraft(data.model || summaryModelDraft);
    setSummaryceptionModelDraft(data.summaryception.model || data.model || summaryceptionModelDraft);
    setSummaryIncludedDraft(data.localdevIncluded ?? data.included ?? true);
    setSummaryceptionIncludedDraft(data.summaryceptionIncluded ?? false);
    setSummaryTriggerDraft(String(data.triggerTokens ?? DEFAULT_SUMMARY_TRIGGER_TOKENS));
    setSummaryRecentTailDraft(String(data.recentTailTokens ?? DEFAULT_SUMMARY_RECENT_TAIL_TOKENS));
    setLanguageDraft(data.language ?? "auto");
  };

  const summaryErrorMessage = (summary: SessionSummaryPayload): string => {
    if (!summary.autoCompactionPaused) return formatSummaryJobError(summary.error ?? "");
    return tt(
      "Automatic summaries paused after 150 updates. Your chat is unaffected.",
      "自动摘要已暂停（150 次更新），聊天不受影响。",
    );
  };

  // Localize the server's machine-readable no-op code into clear, number-aware
  // copy. The server never ships user-facing prose for these (noOpReason is a
  // debug/log fallback only), so Chinese mode gets Chinese text.
  const noOpMessage = (
    compaction: SessionSummaryCompactionMetadata,
    summary: SessionSummaryPayload | null,
  ): string => {
    switch (compaction.noOpReasonCode) {
      case "fits-within-raw-tail": {
        const keptLimit = summary?.recentTailTokens ?? null;
        const currentRaw = summary?.rawChatProgress?.currentTokens ?? null;
        if (keptLimit != null && currentRaw != null) {
          // Two distinct no-op shapes hide behind this code; pick copy from the
          // SAME numbers the panel shows so the message can never contradict
          // them (the "4,175 fits within 4,000" bug). When the raw total is
          // already over the kept-raw tail, the reason isn't "it all fits" — it's
          // that the sliver OLDER than the tail is below the minimum compactable
          // chunk (needs a couple of older messages), so nothing can be folded in.
          if (currentRaw > keptLimit) {
            const excess = currentRaw - keptLimit;
            return tt(
              `Only ${formatTokenCount(excess)} older than your story memory. Not enough to fold in yet.`,
              `超出剧情记忆的只有 ${formatTokenCount(excess)}，还不够折进摘要。`,
            );
          }
          return tt("Nothing older than your story memory yet.", "还没有超出剧情记忆的内容。");
        }
        return tt("Nothing to compress yet.", "暂无可压缩内容。");
      }
      case "batch-already-compacted":
        return tt("This batch has already been compressed.", "这一批次已经压缩过了。");
      case "session-apis-unavailable":
        return tt("Session tools aren't available right now. Reopen the story and try again.", "会话工具当前不可用，请重新打开故事后再试。");
      default:
        // Unknown/unmapped code (e.g. a future server addition). Stay localized
        // rather than surfacing the server's English noOpReason to a zh user;
        // the raw string is still in the payload for debugging.
        return tt("Nothing to compress right now.", "暂时没有可压缩的内容。");
    }
  };

  const handleCompactSummary = async (implementation: SessionSummaryImplementation) => {
    setCompacting(true);
    setError(null);
    // Reflect "updating" the instant the user acts. The job flips the status
    // server-side, but the blocking call only returns when it's DONE and the
    // poll is paused during a local action — so without this the status row
    // would sit on idle/✓ for the whole run (the reopen-to-see-it bug).
    setSummaryPayload((prev) => {
      if (!prev) return prev;
      return implementation === "summaryception"
        ? { ...prev, summaryception: { ...prev.summaryception, status: "updating" as const, error: null } }
        : { ...prev, status: "updating" as const, error: null };
    });
    try {
      const modelForImplementation = implementation === "summaryception"
        ? summaryceptionModelDraft.trim() || undefined
        : summaryModelDraft.trim() || undefined;
      const data = await api.compactSessionSummary(modelForImplementation, implementation, { force: true });
      refreshFromSummaryPayload(data.summary);
      setLastCompaction(data.compaction);
      setLastCompactionImplementation(implementation);
      if (data.compaction.compactedCount > 0) {
        const range = data.compaction.compactedFromOrdinal && data.compaction.compactedToOrdinal
          ? tt(`messages ${data.compaction.compactedFromOrdinal}-${data.compaction.compactedToOrdinal}`, `消息 ${data.compaction.compactedFromOrdinal}-${data.compaction.compactedToOrdinal}`)
          : tt(`${data.compaction.compactedCount} messages`, `${data.compaction.compactedCount} 条消息`);
        const ending = data.compaction.compactedUntilOneLine
          ? tt(` Ending point: ${data.compaction.compactedUntilOneLine}`, ` 结束点：${data.compaction.compactedUntilOneLine}`)
          : "";
        const label = implementation === "summaryception" ? "Layered Summary" : tt("story summary", "剧情摘要");
        api.showToast(tt(`${label} compressed: ${range}.${ending}`, `${label} 已压缩：${range}。${ending}`), "success");
      } else {
        api.showToast(noOpMessage(data.compaction, data.summary), "info");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to compact story context", "压缩故事上下文失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setCompacting(false);
    }
  };

  const handleResumeAutoCompaction = async () => {
    setResumingAutoCompaction(true);
    setError(null);
    try {
      const data = await api.resumeSessionSummaryAutoCompaction();
      refreshFromSummaryPayload(data);
      setDismissedSummaryError(null);
      // No toast. The banner below the button already says "Resuming", and
      // saying it twice for one tap is what made this feel chatty.
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to resume automatic summaries", "恢复失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setResumingAutoCompaction(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await api.saveSessionMemory({ text: memoryDraft.trim() }, modelDraft.trim() || undefined);
      refreshFromPayload(data);
      setEditingMemory(false);
      api.showToast(tt("Session memory saved", "清单记忆已保存"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to save session memory", "保存清单记忆失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await api.clearSessionMemory();
      refreshFromPayload(data);
      setEditingMemory(false);
      api.showToast(tt("Session memory cleared", "清单记忆已清空"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to clear session memory", "清空清单记忆失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    setError(null);
    setPayload((prev) => (prev ? { ...prev, status: "updating" as const, error: null } : prev));
    try {
      const data = await api.regenerateSessionMemory(modelDraft.trim() || undefined);
      refreshFromPayload(data);
      if (data.error) {
        api.showToast(data.error, "error");
      } else if (!data.hasMemory) {
        api.showToast(
          tt(
            "Session memory needs at least two assistant replies before it can be generated",
            "至少需要两条助手回复才能生成清单记忆",
          ),
          "info",
        );
      } else {
        api.showToast(tt("Session memory regenerated", "清单记忆已重新生成"), "success");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to regenerate session memory", "重新生成清单记忆失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setRegenerating(false);
    }
  };

  const handleRetryMemory = async () => {
    setRegenerating(true);
    setError(null);
    try {
      const data = await api.retrySessionMemory();
      refreshFromPayload(data);
      if (data.error) {
        api.showToast(data.error, "error");
      } else if (data.status === "updating") {
        api.showToast(tt("Memory is already updating", "记忆正在更新中"), "info");
      } else if ((data.pendingTurns ?? 0) > 0) {
        api.showToast(tt("Memory updated; more turns remain to process", "记忆已更新，还有对话待处理"), "info");
      } else if (data.pendingTurns === null) {
        api.showToast(tt("Memory coverage still needs reconciliation", "记忆覆盖范围仍待修复"), "info");
      } else {
        api.showToast(tt("Memory is up to date with eligible turns", "记忆已补齐至可处理的对话"), "success");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to retry memory", "重试记忆更新失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setRegenerating(false);
    }
  };

  const startEditPinned = () => {
    setPinnedDraft(payload?.pinned ?? "");
    setEditingPinned(true);
  };

  const cancelEditPinned = () => {
    setPinnedDraft(payload?.pinned ?? "");
    setEditingPinned(false);
  };

  const handleSavePinned = async () => {
    setSavingPinned(true);
    setError(null);
    try {
      const trimmed = pinnedDraft.trim();
      const data = await api.saveSessionMemoryPinned(trimmed ? trimmed : null);
      refreshFromPayload(data);
      setEditingPinned(false);
      api.showToast(tt("Pinned notes saved", "固定记忆已保存"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to save pinned notes", "保存固定记忆失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setSavingPinned(false);
    }
  };

  const handleSaveSummary = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await api.saveSessionSummary(summaryDraft, summaryModelDraft.trim() || undefined);
      refreshFromSummaryPayload(data);
      setEditingSummary(false);
      api.showToast(tt("Story summary saved", "剧情摘要已保存"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to save story summary", "保存故事摘要失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleClearSummary = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await api.clearSessionSummary();
      refreshFromSummaryPayload(data);
      setEditingSummary(false);
      api.showToast(tt("Story summary cleared", "剧情摘要已清空"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to clear story summary", "清空故事摘要失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerateSummary = async () => {
    const previousJobId = summaryPayload?.job?.id;
    setRegenerating(true);
    setError(null);
    setSummaryPayload((prev) => (prev ? { ...prev, status: "updating" as const, error: null } : prev));
    try {
      const data = await api.regenerateSessionSummary(summaryModelDraft.trim() || undefined);
      refreshFromSummaryPayload(data);
      observedSummaryJob.current = data.job;
      if (data.job?.status === "queued" || data.job?.status === "running") {
        api.showToast(tt("Summary started. You can close this panel while it runs.", "摘要已开始生成，期间可以关闭此面板。"), "info");
      } else if (data.error) {
        api.showToast(formatSummaryJobError(data.error), "error");
      } else {
        api.showToast(tt("Story summary regenerated", "剧情摘要已重新生成"), "success");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to regenerate story summary", "重新生成故事摘要失败");
      // A lost receipt is not proof of a failed job. Reconcile before offering a retry.
      try {
        const current = await api.getSessionSummary();
        refreshFromSummaryPayload(current);
        observedSummaryJob.current = current.job;
        if (current.job?.status === "queued" || current.job?.status === "running"
          || (current.job?.status === "completed" && current.job.id !== previousJobId)) {
          setError(null);
          return;
        }
      } catch { /* The regular poll will reconnect when the network recovers. */ }
      setError(message);
      api.showToast(message, "error");
    } finally {
      setRegenerating(false);
    }
  };

  const handleSelectMemoryModel = (modelId: string) => {
    setModelDraft(modelId);
    api.setSessionMemoryModel(modelId)
      .then(refreshFromPayload)
      .catch((err) => {
        const message = err instanceof Error ? err.message : tt("Failed to save memory model", "保存记忆模型失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const handleSelectSummaryModel = (modelId: string) => {
    setSummaryModelDraft(modelId);
    api.setSessionSummaryModel(modelId)
      .then(refreshFromSummaryPayload)
      .catch((err) => {
        const message = err instanceof Error ? err.message : tt("Failed to save summary model", "保存摘要模型失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const handleSelectSummaryceptionModel = (modelId: string) => {
    setSummaryceptionModelDraft(modelId);
    api.setSessionSummaryceptionModel(modelId)
      .then(refreshFromSummaryPayload)
      .catch((err) => {
        const message = err instanceof Error ? err.message : tt("Failed to save Layered Summary model", "保存分层摘要模型失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const handleSelectLanguage = (language: SessionSummaryLanguage) => {
    const previous = languageDraft;
    setLanguageDraft(language);
    api.setSessionSummaryLanguage(language)
      .then(refreshFromSummaryPayload)
      .catch((err) => {
        setLanguageDraft(previous);
        const message = err instanceof Error ? err.message : tt("Failed to save summary language", "保存纪要语言失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const handleToggleMemoryIncluded = (included: boolean) => {
    setMemoryIncludedDraft(included);
    api.setSessionMemoryIncluded(included)
      .then(refreshFromPayload)
      .catch((err) => {
        setMemoryIncludedDraft(!included);
        const message = err instanceof Error ? err.message : tt("Failed to save memory include setting", "保存记忆注入设置失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const handleToggleSummaryIncluded = (included: boolean) => {
    setSummaryIncludedDraft(included);
    api.setSessionSummaryIncluded(included)
      .then(refreshFromSummaryPayload)
      .catch((err) => {
        setSummaryIncludedDraft(!included);
        const message = err instanceof Error ? err.message : tt("Failed to save summary include setting", "保存摘要注入设置失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const handleToggleSummaryceptionIncluded = (included: boolean) => {
    setSummaryceptionIncludedDraft(included);
    api.setSessionSummaryceptionIncluded(included)
      .then(refreshFromSummaryPayload)
      .catch((err) => {
        setSummaryceptionIncludedDraft(!included);
        const message = err instanceof Error ? err.message : tt("Failed to save Layered Summary include setting", "保存分层摘要注入设置失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const handleApplySummaryTrigger = () => {
    const numeric = Number(summaryTriggerDraft);
    if (!Number.isFinite(numeric)) {
      const message = tt("Summary threshold must be a number", "摘要阈值必须是数字");
      setError(message);
      api.showToast(message, "error");
      return;
    }
    const triggerTokens = Math.max(
      MIN_SUMMARY_TRIGGER_TOKENS,
      Math.min(MAX_SUMMARY_TRIGGER_TOKENS, Math.floor(numeric)),
    );
    setSummaryTriggerDraft(String(triggerTokens));
    api.setSessionSummaryTriggerTokens(triggerTokens)
      .then(refreshFromSummaryPayload)
      .catch((err) => {
        const message = err instanceof Error ? err.message : tt("Failed to save summary threshold", "保存摘要阈值失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const handleApplySummaryRecentTail = () => {
    const numeric = Number(summaryRecentTailDraft);
    if (!Number.isFinite(numeric)) {
      const message = tt("Raw kept tokens must be a number", "保留原文 tokens 必须是数字");
      setError(message);
      api.showToast(message, "error");
      return;
    }
    const recentTailTokens = Math.max(
      MIN_SUMMARY_RECENT_TAIL_TOKENS,
      Math.min(MAX_SUMMARY_RECENT_TAIL_TOKENS, Math.floor(numeric)),
    );
    setSummaryRecentTailDraft(String(recentTailTokens));
    api.setSessionSummaryRecentTailTokens(recentTailTokens)
      .then(refreshFromSummaryPayload)
      .catch((err) => {
        const message = err instanceof Error ? err.message : tt("Failed to save raw context setting", "保存原文上下文设置失败");
        setError(message);
        api.showToast(message, "error");
      });
  };

  const startEditMemory = () => {
    setMemoryDraft(memoryToText(payload?.memory));
    setEditingMemory(true);
  };

  const cancelEditMemory = () => {
    setMemoryDraft(memoryToText(payload?.memory));
    setEditingMemory(false);
  };

  const startEditSummary = () => {
    setSummaryDraft(summaryPayload?.summary ?? "");
    setEditingSummary(true);
  };

  const cancelEditSummary = () => {
    setSummaryDraft(summaryPayload?.summary ?? "");
    setEditingSummary(false);
  };

  const handleSaveSnippet = async (snippetId: string) => {
    const text = snippetDraft.trim();
    if (!text) {
      api.showToast(tt("Snippet text cannot be empty", "片段内容不能为空"), "error");
      return;
    }
    setSavingSnippet(true);
    setError(null);
    try {
      const data = await api.updateSummaryceptionSnippet(snippetId, text);
      refreshFromSummaryPayload(data);
      setEditingSnippetId(null);
      api.showToast(tt("Snippet updated", "片段已更新"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : tt("Failed to update snippet", "更新片段失败");
      setError(message);
      api.showToast(message, "error");
    } finally {
      setSavingSnippet(false);
    }
  };

  const memoryModel = modelDraft.trim() || DEFAULT_CONTEXT_MODEL;
  const summaryModel = summaryModelDraft.trim() || DEFAULT_CONTEXT_MODEL;
  const summaryceptionModel = summaryceptionModelDraft.trim() || DEFAULT_CONTEXT_MODEL;
  const rawProgress = summaryPayload?.rawChatProgress ?? null;
  const rawProgressPercent = rawProgress ? Math.max(0, Math.min(100, rawProgress.percent)) : 0;
  const summaryceptionLayers = summaryPayload?.summaryception.layers ?? [];

  const renderSystemCard = (args: {
    title: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    meta: string;
    model: string;
    usage: SessionMemoryUsageSummary | null | undefined;
    onPickModel: () => void;
    onUseFreeModel: () => void;
    description: ReactNode;
  }) => (
    <section className="flex min-w-0 flex-col rounded-lg border border-white/[0.06] bg-black/18 p-3">
      <label className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[11px] font-semibold text-white/72">{args.title}</span>
          <span className="block text-[10px] leading-relaxed text-white/25">{args.meta}</span>
        </span>
        <input
          type="checkbox"
          checked={args.checked}
          onChange={(e) => args.onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
        />
      </label>
      <div className="mt-3">
        <ModelTrigger
          model={args.model}
          onClick={args.onPickModel}
          className="mx-0 max-w-full"
        />
        {args.model === FREE_CONTEXT_MODEL ? (
          <p className="mt-1.5 text-[10px] leading-relaxed text-emerald-200/60">
            {tt("Free updates", "免费更新")}
          </p>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-[10px] leading-relaxed text-amber-200/60">
              {tt("Paid per update", "按次计费")}
            </p>
            <button
              onClick={args.onUseFreeModel}
              className="rounded-md border border-emerald-300/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-100/80 transition-colors hover:bg-emerald-500/15"
            >
              {tt("Use free model", "使用免费模型")}
            </button>
          </div>
        )}
      </div>
      {renderUsageStats(args.usage)}
      <div className="mt-3 text-[11px] leading-relaxed text-white/42">
        {args.description}
      </div>
    </section>
  );

  const renderTabButton = (args: { tab: ContextTab; icon: ReactNode; label: string }) => (
    <button
      onClick={() => setContextTab(args.tab)}
      aria-pressed={contextTab === args.tab}
      className={`flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-1 py-2 text-xs font-semibold transition-colors sm:px-3 ${
        contextTab === args.tab ? "bg-primary/15 text-primary" : "bg-white/[0.03] text-white/45 hover:text-white/70"
      }`}
    >
      <span className="hidden sm:inline-flex">{args.icon}</span>
      {args.label}
    </button>
  );

  const renderSnippetSource = (snippet: SessionSummaryPayload["summaryception"]["layers"][number]["snippets"][number]) => {
    if (snippet.sourceStartOrdinal && snippet.sourceEndOrdinal) {
      return snippet.sourceStartOrdinal === snippet.sourceEndOrdinal
        ? tt(`message ${snippet.sourceStartOrdinal}`, `消息 ${snippet.sourceStartOrdinal}`)
        : tt(`messages ${snippet.sourceStartOrdinal}-${snippet.sourceEndOrdinal}`, `消息 ${snippet.sourceStartOrdinal}-${snippet.sourceEndOrdinal}`);
    }
    if (snippet.fromLayer != null) {
      return snippet.promoted
        ? tt(`promoted seed from layer ${snippet.fromLayer}`, `来自第 ${snippet.fromLayer} 层的提升种子`)
        : tt(`folded from layer ${snippet.fromLayer}`, `从第 ${snippet.fromLayer} 层折叠`);
    }
    return tt("source pending", "来源待定");
  };

  const renderStatusIcon = (status: string | null | undefined) => {
    if (status === "updating") return <Loader2 className="h-3 w-3 animate-spin text-primary" />;
    if (status === "failed") return <AlertCircle className="h-3 w-3 text-red-300" />;
    return <Check className="h-3 w-3 text-emerald-300" />;
  };

  // Raw server statuses ("idle"/"updating"/"failed") leaked into the UI
  // untranslated. Players see a word, not a state-machine value.
  const statusLabel = (status: string | null | undefined): string => {
    if (status === "updating") return tt("Updating", "更新中");
    if (status === "failed") return tt("Failed", "失败");
    return tt("Ready", "就绪");
  };

  // Session-wide background spend across all three systems, for the Home tab.
  // The per-card breakdowns already exist (renderUsageStats); this is the
  // at-a-glance total a player checks before asking "what is this costing me".
  const sessionUsageTotals = (() => {
    let mushies = 0;
    let calls = 0;
    for (const u of [payload?.usage, summaryPayload?.usage, summaryPayload?.summaryception.usage]) {
      if (!u) continue;
      mushies += u.estimatedMushies ?? 0;
      calls += u.requestCount ?? 0;
    }
    return { mushies, calls };
  })();

  const renderUsageStats = (usage: SessionMemoryUsageSummary | null | undefined) => {
    const last = usage?.last ?? null;
    if (!usage || (!last && !usage.requestCount)) return null;
    return (
      <details className="mt-2 text-xs text-white/60">
        <summary className="cursor-pointer py-1 hover:text-white/80">
          {tt(`Usage · ~${formatMushies(usage.estimatedMushies)} mushies`, `用量 · 约 ${formatMushies(usage.estimatedMushies)} 蘑菇`)}
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-white/25">{tt("Last update", "上次更新")}</p>
            {last ? (
              <>
                <p className="mt-1 text-[11px] font-semibold text-white/72">
                  {formatTokenCount(last.totalTokens)} tokens
                </p>
                <p className="mt-0.5 text-[10px] text-white/35">
                  {tt(`${formatMushies(last.estimatedMushies)} est. mushies`, `约 ${formatMushies(last.estimatedMushies)} mushies`)}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[11px] text-white/35">{tt("No usage logged yet", "暂无用量记录")}</p>
            )}
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-white/25">{tt("Session total", "会话总计")}</p>
            <p className="mt-1 text-[11px] font-semibold text-white/72">
              {formatTokenCount(usage?.totalTokens)} tokens
            </p>
            <p className="mt-0.5 text-[10px] text-white/35">
              {tt(`${formatMushies(usage?.estimatedMushies)} est. mushies - ${usage?.requestCount ?? 0} calls`, `约 ${formatMushies(usage?.estimatedMushies)} mushies · ${usage?.requestCount ?? 0} 次调用`)}
            </p>
          </div>
        </div>
        {last && (
          <p className="mt-2 truncate text-[10px] text-white/28" title={`${last.model} - ${formatDate(last.createdAt)}`}>
            {last.model} - {formatDate(last.createdAt)}
          </p>
        )}
      </details>
    );
  };

  const renderError = (message: string | null | undefined) => message ? (
    <details className="mt-2 text-xs text-red-300/90">
      <summary className="cursor-pointer py-1">{tt("Error details", "错误详情")}</summary>
      <p className="mt-1 break-words leading-relaxed">{message}</p>
    </details>
  ) : null;

  const renderLastCompaction = (implementation: SessionSummaryImplementation) => {
    if (!lastCompaction || lastCompactionImplementation !== implementation) return null;
    return (
      <div className={`mb-4 rounded-xl border px-4 py-3 ${
        lastCompaction.compactedCount > 0
          ? "border-emerald-300/15 bg-emerald-500/8"
          : "border-white/[0.06] bg-white/[0.025]"
      }`}>
        <p className={`text-xs font-semibold ${
          lastCompaction.compactedCount > 0 ? "text-emerald-100/80" : "text-white/55"
        }`}>
          {lastCompaction.compactedCount > 0
            ? tt(
                `Compressed ${lastCompaction.compactedCount} messages${
                  lastCompaction.compactedFromOrdinal && lastCompaction.compactedToOrdinal
                    ? ` (${lastCompaction.compactedFromOrdinal}-${lastCompaction.compactedToOrdinal})`
                    : ""
                }.`,
                `已压缩 ${lastCompaction.compactedCount} 条消息${
                  lastCompaction.compactedFromOrdinal && lastCompaction.compactedToOrdinal
                    ? `（${lastCompaction.compactedFromOrdinal}-${lastCompaction.compactedToOrdinal}）`
                    : ""
                }。`,
              )
            : tt("No context was compressed.", "没有压缩任何上下文。")}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-white/45">
          {lastCompaction.compactedUntilOneLine
            || (lastCompaction.compactedCount > 0
              ? tt("Recent chat is still being kept raw.", "最近的聊天仍保留为原文。")
              : noOpMessage(lastCompaction, summaryPayload))}
        </p>
      </div>
    );
  };

  return (
    <>
      <SandboxPlatformOverlay>
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center pt-[calc(env(safe-area-inset-top,0px)+2.5rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={tt("Memory & Summary", "记忆与摘要")}
        >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 flex max-h-[min(760px,calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-4rem))] w-[min(840px,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#17181b]/95 shadow-2xl shadow-black/45 backdrop-blur-xl"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="text-primary">
                <Brain className="h-4 w-4" />
              </div>
              <div>
                <h2 className="flex items-center gap-2 text-sm font-bold text-white">
                  {tt("Memory & Summary", "记忆与摘要")}
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200/80" title={tt("Experimental; may miss details.", "测试中，可能遗漏细节。")}>{tt("Beta", "测试版")}</span>
                </h2>
              </div>
            </div>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-white/5 hover:text-white/70"
              title={tt("Close", "关闭")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="shrink-0 border-b border-white/[0.06] px-3 py-2">
            <div className="grid grid-cols-4 gap-1">
              {renderTabButton({ tab: "systems", icon: <Settings2 className="h-3.5 w-3.5" />, label: tt("Settings", "设置") })}
              {renderTabButton({ tab: "memory", icon: <Brain className="h-3.5 w-3.5" />, label: tt("Memory", "记忆") })}
              {renderTabButton({ tab: "localdev", icon: <FileText className="h-3.5 w-3.5" />, label: tt("Summary", "摘要") })}
              {renderTabButton({ tab: "summaryception", icon: <Layers3 className="h-3.5 w-3.5" />, label: tt("Layers", "分层") })}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-white/40">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {tt("Loading…", "加载中…")}
              </div>
            ) : (
              <>
                {contextTab === "systems" && (
                  <div className="space-y-3">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-bold text-white/78">{tt("Memory systems", "记忆系统")}</p>
                      </div>
                      <span className="rounded-full border border-white/[0.08] bg-black/20 px-2.5 py-1 text-[10px] font-semibold tabular-nums text-white/40">
                        {sessionUsageTotals.calls > 0
                          ? tt(
                              `This session: ${sessionUsageTotals.calls} updates · ~${formatMushies(sessionUsageTotals.mushies)} mushies`,
                              `本会话 ${sessionUsageTotals.calls} 次更新 · 约 ${formatMushies(sessionUsageTotals.mushies)} mushies`,
                            )
                          : tt("This session: no cost yet", "本会话尚无消耗")}
                      </span>
                    </div>
                    <div className="mb-3 rounded-lg border border-white/[0.06] bg-black/18 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold text-white/72">{tt("Summary language", "纪要语言")}</p>
                        </div>
                        <select
                          value={languageDraft}
                          onChange={(e) => handleSelectLanguage(e.target.value as SessionSummaryLanguage)}
                          className="h-8 shrink-0 rounded-lg border border-white/[0.1] bg-black/40 px-2.5 text-[11px] font-medium text-white/80 outline-none transition-colors hover:border-white/20 focus:border-primary/50"
                          aria-label={tt("Summary language", "纪要语言")}
                        >
                          {SESSION_SUMMARY_LANGUAGES.map((code) => (
                            <option key={code} value={code} className="bg-[#17181b] text-white">
                              {code === "auto"
                                ? tt("Auto (story language)", "自动（故事语言）")
                                : SESSION_SUMMARY_LANGUAGE_ENDONYMS[code]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-white/42">
                        {tt("Applies to future updates. Names stay unchanged.", "对后续更新生效，专有名称保持原文。")}
                      </p>
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      {renderSystemCard({
                        title: tt("Session Memory", "会话记忆"),
                        checked: memoryIncludedDraft,
                        onChange: handleToggleMemoryIncluded,
                        meta: `${statusLabel(payload?.status)} · ${formatDate(payload?.updatedAt ?? null)}`,
                        model: memoryModel,
                        usage: payload?.usage,
                        onPickModel: () => setMemoryModelPickerOpen(true),
                        onUseFreeModel: () => handleSelectMemoryModel(FREE_CONTEXT_MODEL),
                        description: (
                          <p>{tt("Tracks key facts, characters, and goals.", "记录关键事实、角色和目标。")}</p>
                        ),
                      })}
                      {renderSystemCard({
                        title: tt("Story Summary", "剧情摘要"),
                        checked: summaryIncludedDraft,
                        onChange: handleToggleSummaryIncluded,
                        meta: `${statusLabel(summaryPayload?.status)} · ${formatTokenCount(summaryPayload?.tokenCount)} tokens`,
                        model: summaryModel,
                        usage: summaryPayload?.usage,
                        onPickModel: () => setSummaryModelPickerOpen(true),
                        onUseFreeModel: () => handleSelectSummaryModel(FREE_CONTEXT_MODEL),
                        description: (
                          <p>{tt("Recaps earlier events.", "概括之前的剧情。")}</p>
                        ),
                      })}
                      {renderSystemCard({
                        title: tt("Layered Summary", "分层摘要"),
                        checked: summaryceptionIncludedDraft,
                        onChange: handleToggleSummaryceptionIncluded,
                        meta: tt(`${statusLabel(summaryPayload?.summaryception.status)} · ${summaryPayload?.summaryception.snippetCount ?? 0} snippets`, `${statusLabel(summaryPayload?.summaryception.status)} · ${summaryPayload?.summaryception.snippetCount ?? 0} 个片段`),
                        model: summaryceptionModel,
                        usage: summaryPayload?.summaryception.usage,
                        onPickModel: () => setSummaryceptionModelPickerOpen(true),
                        onUseFreeModel: () => handleSelectSummaryceptionModel(FREE_CONTEXT_MODEL),
                        description: (
                          <p>{tt("Layered notes for long stories. Experimental.", "超长故事的分层笔记（实验性）。")}</p>
                        ),
                      })}
                    </div>
                    {error && (
                      <p className="mt-3 text-[11px] leading-relaxed text-red-300/80">{error}</p>
                    )}
                  </div>
                )}

                {contextTab === "memory" && (
                  <>
                    <div className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/60">
                        <span className="inline-flex items-center gap-1.5">
                          {renderStatusIcon(payload?.status)}
                          {statusLabel(payload?.status)}
                        </span>
                        <span>{tt("Updated:", "更新于：")} {formatDate(payload?.updatedAt ?? null)}</span>
                        <span>{tt("Model:", "模型：")} {(payload?.model || memoryModel).split("/").pop()}</span>
                      </div>
                      {renderUsageStats(payload?.usage)}
                      {payload?.memory.warning === "truncated" && (
                        <p role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100/90">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          {tt("Memory was cut short and may be missing details. Regenerate or edit it.", "记忆被截断，可能缺少细节。可重新生成或编辑。")}
                        </p>
                      )}
                      {payload?.autoPaused && (
                        <p className="mt-2 text-[11px] leading-relaxed text-amber-200/80">
                          {tt("Paused after 3 failures. Previous memory kept.", "失败 3 次，自动记忆已暂停。旧记忆已保留。")}
                        </p>
                      )}
                      {typeof payload?.pendingTurns === "number" && payload.pendingTurns > 0 && (
                        <p className="mt-2 text-[11px] leading-relaxed text-white/50">
                          {tt(`${payload.pendingTurns} replies pending.`, `${payload.pendingTurns} 轮对话待更新。`)}
                        </p>
                      )}
                      {payload?.pendingTurns === null && (
                        <p className="mt-2 text-[11px] leading-relaxed text-white/50">
                          {tt("Memory coverage unknown. Retry to repair.", "记忆覆盖范围未知，请重试修复。")}
                        </p>
                      )}
                      {payload && (payload.status === "failed" || payload.pendingTurns === null || (payload.pendingTurns ?? 0) > 0) && (
                        <button
                          onClick={handleRetryMemory}
                          disabled={saving || regenerating || compacting || loading || editingMemory}
                          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-amber-300/20 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-100/85 disabled:opacity-40"
                        >
                          {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                          {tt("Retry", "重试")}
                        </button>
                      )}
                      {renderError(error || payload?.error)}
                    </div>

                    {/* Player-pinned notes: the one block the updater never rewrites.
                        Lives above the auto memory so it reads as the anchor. */}
                    <div className="mb-4 rounded-xl border border-amber-300/15 bg-amber-500/[0.04] px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-100/85">
                            <Pin className="h-3.5 w-3.5" />
                            {tt("Pinned notes", "固定记忆")}
                          </div>
                          <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                            {tt(
                              "Facts that must never drift. The AI never rewrites these.",
                              "绝不能跑偏的事实。AI 不会改写这里。",
                            )}
                          </p>
                        </div>
                        {!editingPinned && (
                          <button
                            onClick={startEditPinned}
                            disabled={saving || regenerating || compacting || loading || savingPinned}
                            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-semibold text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
                          >
                            <Pencil className="h-3 w-3" />
                            {tt("Edit", "编辑")}
                          </button>
                        )}
                      </div>
                      {editingPinned ? (
                        <div className="mt-3 space-y-2">
                          <textarea
                            value={pinnedDraft}
                            onChange={(e) => setPinnedDraft(e.target.value.slice(0, PINNED_MAX_CHARS))}
                            maxLength={PINNED_MAX_CHARS}
                            spellCheck={false}
                            placeholder={tt("e.g. Lina died in chapter 3 — she never returns. The player is 24 and lives alone.", "例如：莉娜在第三章已经死了，不会再出场。主角 24 岁，独居。")}
                            className="min-h-[160px] w-full resize-y rounded-xl border border-white/[0.08] bg-black/25 p-3 text-xs leading-relaxed text-white/75 outline-none placeholder:text-white/25 focus:border-amber-300/35"
                          />
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-[10px] ${pinnedDraft.length >= PINNED_MAX_CHARS ? "text-amber-200/80" : "text-white/30"}`}>
                              {pinnedDraft.length} / {PINNED_MAX_CHARS}
                            </span>
                            <div className="flex items-center gap-2">
                            <button
                              onClick={cancelEditPinned}
                              disabled={savingPinned}
                              className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
                            >
                              <X className="h-3 w-3" />
                              {tt("Cancel", "取消")}
                            </button>
                            <button
                              onClick={handleSavePinned}
                              disabled={savingPinned}
                              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground transition-opacity disabled:opacity-40"
                            >
                              {savingPinned ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                              {tt("Save", "保存")}
                            </button>
                            </div>
                          </div>
                        </div>
                      ) : pinnedText ? (
                        <div className="mt-3 whitespace-pre-wrap rounded-lg bg-black/25 p-3 text-xs leading-relaxed text-white/75">
                          {pinnedText}
                        </div>
                      ) : (
                        <p className="mt-3 text-[11px] leading-relaxed text-white/30">
                          {tt("Nothing pinned yet.", "还没有固定内容。")}
                        </p>
                      )}
                    </div>

                    {!editingMemory ? (
                      hasAnyMemory ? (
                        <MemoryTextView text={memoryText} />
                      ) : (
                        <p className="rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-center text-xs leading-relaxed text-white/30">
                          {tt("No memory yet. Keep playing or generate it now.", "暂无记忆。继续游玩或点击「重新生成」。")}
                        </p>
                      )
                    ) : (
                      <div className="space-y-3">
                        <p className="text-[11px] leading-relaxed text-white/35">
                          {tt("Edit what the AI remembers.", "编辑 AI 需要记住的内容。")}
                        </p>
                        <textarea
                          value={memoryDraft}
                          onChange={(e) => setMemoryDraft(e.target.value)}
                          spellCheck={false}
                          placeholder={tt("Core facts, relationships, goals, promises, world state, risks...", "核心事实、人物关系、目标、承诺、世界状态、风险……")}
                          className="min-h-[420px] w-full resize-y rounded-xl border border-white/[0.08] bg-black/25 p-4 text-xs leading-relaxed text-white/75 outline-none placeholder:text-white/25 focus:border-primary/35"
                        />
                      </div>
                    )}
                  </>
                )}

                {contextTab === "localdev" && (
                  <>
                    <div className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/60">
                        <span className="inline-flex items-center gap-1.5">
                          {renderStatusIcon(summaryPayload?.status)}
                          {statusLabel(summaryPayload?.status)}
                        </span>
                        <span>{tt("Updated:", "更新于：")} {formatDate(summaryPayload?.updatedAt ?? null)}</span>
                        <span>{tt("Model:", "模型：")} {(summaryPayload?.model || summaryModel).split("/").pop()}</span>
                        <span>{tt("Summary size:", "摘要长度：")} {formatTokenCount(summaryPayload?.tokenCount)} tokens</span>
                      </div>
                      {renderUsageStats(summaryPayload?.usage)}
                      {error && (
                        <p className="mt-2 text-[11px] leading-relaxed text-red-300/80">{error}</p>
                      )}
                      {summaryJobActive && (
                        <p role="status" className="mt-2 text-base text-primary">
                          {summaryPayload?.job?.status === "queued"
                            ? tt("Summary queued", "摘要已排队")
                            : summaryPayload?.job?.phase === "merge"
                              ? tt("Combining completed summaries…", "正在合并已完成的摘要…")
                              : `${tt("Summarizing chunks", "正在生成分段摘要")}: ${summaryPayload?.job?.completed ?? 0} / ${summaryPayload?.job?.total || "…"}`}
                        </p>
                      )}
                      {summaryPayload?.error && dismissedSummaryError !== summaryPayload.error && (
                        <div className="mt-3 rounded-lg border border-red-300/15 bg-red-500/8 px-3 py-2.5">
                          <p className="text-[11px] leading-relaxed text-red-200/80">{summaryErrorMessage(summaryPayload)}</p>
                          {summaryPayload.autoCompactionPaused && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                onClick={() => setDismissedSummaryError(summaryPayload.error)}
                                className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white/80"
                              >
                                {tt("Dismiss", "关闭提示")}
                              </button>
                              {summaryPayload.autoCompactionCanResume && (
                                <button
                                  onClick={handleResumeAutoCompaction}
                                  aria-label={tt("Resume automatic summaries", "恢复自动摘要")}
                                  disabled={resumingAutoCompaction}
                                  className="inline-flex items-center gap-1.5 rounded-md border border-primary/25 bg-primary/12 px-2.5 py-1 text-[10px] font-semibold text-primary transition-colors hover:bg-primary/18 disabled:opacity-40"
                                >
                                  {resumingAutoCompaction && <Loader2 className="h-3 w-3 animate-spin" />}
                                  {tt("Resume", "恢复")}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {summaryPayload?.autoCompactionResumePending && (
                        <p className="mt-2 text-[11px] leading-relaxed text-amber-200/70">
                          {tt(
                            "Resuming on the next compression.",
                            "下次压缩时恢复。",
                          )}
                        </p>
                      )}
                      <details className="mt-3">
                        <summary className="cursor-pointer py-1 text-xs text-white/60 hover:text-white/80">{tt("Settings & context", "设置与上下文")}</summary>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-white/25">{tt("Compress when chat passes", "对话超过时压缩")}</span>
                        <input
                          type="number"
                          min={MIN_SUMMARY_TRIGGER_TOKENS}
                          max={MAX_SUMMARY_TRIGGER_TOKENS}
                          step={1000}
                          value={summaryTriggerDraft}
                          onChange={(e) => setSummaryTriggerDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                            if (e.key === "Enter") handleApplySummaryTrigger();
                          }}
                          className="h-8 w-32 rounded-lg border border-white/[0.08] bg-black/25 px-3 text-[11px] font-semibold text-white/70 outline-none focus:border-primary/35"
                          title={tt("Older scenes get folded into the recap once raw chat grows past this.", "原文超过这个长度后，更早的场景会被折进前情提要。")}
                        />
                        <button
                          onClick={handleApplySummaryTrigger}
                          className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white/80"
                        >
                          {tt("Apply", "应用")}
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-white/25">{tt("Story memory, this story", "本篇剧情记忆")}</span>
                        <input
                          type="number"
                          min={MIN_SUMMARY_RECENT_TAIL_TOKENS}
                          max={MAX_SUMMARY_RECENT_TAIL_TOKENS}
                          step={1000}
                          value={summaryRecentTailDraft}
                          onChange={(e) => setSummaryRecentTailDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                            if (e.key === "Enter") handleApplySummaryRecentTail();
                          }}
                          className="h-8 w-32 rounded-lg border border-white/[0.08] bg-black/25 px-3 text-[11px] font-semibold text-white/70 outline-none focus:border-primary/35"
                          title={tt("How much recent chat this story keeps word for word. Overrides your global story memory setting.", "本篇逐字保留多少最近对话。会覆盖设置里的全局剧情记忆。")}
                        />
                        <button
                          onClick={handleApplySummaryRecentTail}
                          className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white/80"
                        >
                          {tt("Apply", "应用")}
                        </button>
                      </div>
                      {rawProgress && (
                        <div className="mt-3 rounded-lg border border-white/[0.06] bg-black/18 p-3">
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <div>
                              <p className="text-[11px] font-semibold text-white/70">{tt("Chat waiting to be compressed", "待压缩的对话")}</p>
                              <p className="mt-0.5 text-[10px] text-white/35">
                                {formatTokenCount(rawProgress.currentTokens)} / {formatTokenCount(rawProgress.triggerTokens)} tokens
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-[11px] font-bold text-white/75">{rawProgressPercent}%</p>
                              <p className="mt-0.5 text-[10px] text-white/35">
                                {rawProgress.canCompactNow
                                  ? tt("Ready", "就绪")
                                  : rawProgress.remainingTokens <= 0
                                    ? tt("Still fits in story memory", "还没超过剧情记忆")
                                    : tt(`${formatTokenCount(rawProgress.remainingTokens)} left`, `还差 ${formatTokenCount(rawProgress.remainingTokens)}`)}
                              </p>
                            </div>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]">
                            <div
                              className={`h-full rounded-full transition-all ${
                                rawProgress.canCompactNow ? "bg-emerald-300" : "bg-primary"
                              }`}
                              style={{ width: `${rawProgressPercent}%` }}
                            />
                          </div>
                          {/* The bar above already gives current, limit, percent
                              and remaining. Message counts answered a question
                              nobody was asking. */}
                          <p className="mt-2 text-[10px] text-white/35">
                            {tt(
                              `${formatTokenCount(rawProgress.recentTailTokens)} stays word for word`,
                              `逐字保留 ${formatTokenCount(rawProgress.recentTailTokens)}`,
                            )}
                          </p>
                        </div>
                      )}
                      </details>
                    </div>
                    {renderLastCompaction("localdev")}
                    {!editingSummary ? (
                      summaryDraft.trim() ? (
                        <div className="min-h-[200px] w-full whitespace-pre-wrap rounded-xl border border-white/[0.08] bg-black/25 p-4 text-xs leading-relaxed text-white/75">
                          {summaryDraft}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-10 text-center text-xs leading-relaxed text-white/30">
                          {tt("No summary yet. Compress chat or write your own.", "暂无摘要。压缩聊天或自行编辑。")}
                        </div>
                      )
                    ) : (
                      <textarea
                        value={summaryDraft}
                        onChange={(e) => setSummaryDraft(e.target.value)}
                        spellCheck={false}
                        placeholder={tt("Story summary…", "剧情摘要…")}
                        className="min-h-[470px] w-full resize-y rounded-xl border border-white/[0.08] bg-black/25 p-4 text-xs leading-relaxed text-white/75 outline-none placeholder:text-white/25 focus:border-primary/35"
                      />
                    )}
                  </>
                )}

                {contextTab === "summaryception" && (
                  <>
                    <div className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3">
                      <div className="grid gap-2 text-xs text-white/60 sm:grid-cols-2">
                        <span className="inline-flex items-center gap-1.5">
                          {renderStatusIcon(summaryPayload?.summaryception.status)}
                          {statusLabel(summaryPayload?.summaryception.status)}
                        </span>
                        <span>{tt(`${summaryPayload?.summaryception.layerCount ?? 0} layers · ${summaryPayload?.summaryception.snippetCount ?? 0} snippets`, `${summaryPayload?.summaryception.layerCount ?? 0} 层 · ${summaryPayload?.summaryception.snippetCount ?? 0} 个片段`)}</span>
                      </div>
                      <details className="mt-2 text-xs text-white/60">
                        <summary className="cursor-pointer py-1 hover:text-white/80">{tt("Details", "详情")}</summary>
                        <div className="mt-2 grid gap-2 break-words sm:grid-cols-2">
                        <span>{tt("Model:", "模型：")} {summaryPayload?.summaryception.model || summaryceptionModel}</span>
                        <span>{tt("Layers:", "层数：")} {summaryPayload?.summaryception.layerCount ?? 0}</span>
                        <span>{tt("Snippets:", "片段数：")} {summaryPayload?.summaryception.snippetCount ?? 0}</span>
                        <span>{tt("Size:", "长度：")} {formatTokenCount(summaryPayload?.summaryception.tokenCount)} tokens</span>
                        <span>{tt("Updated:", "更新于：")} {formatDate(summaryPayload?.summaryception.updatedAt ?? null)}</span>
                        <span>{tt("Coverage:", "覆盖范围：")} {summaryPayload?.summaryception.coversUntilOrdinal ? tt(`through message ${summaryPayload.summaryception.coversUntilOrdinal}`, `至第 ${summaryPayload.summaryception.coversUntilOrdinal} 条消息`) : tt("Nothing compressed yet", "尚未压缩")}</span>
                        </div>
                      </details>
                      {renderUsageStats(summaryPayload?.summaryception.usage)}
                      {renderError(error || summaryPayload?.summaryception.error)}
                      <p className="mt-3 text-[11px] leading-relaxed text-white/38">
                        {tt("Higher layers condense older events.", "层数越高，内容越精简。")}
                      </p>
                    </div>
                    {renderLastCompaction("summaryception")}
                    {summaryceptionLayers.length > 0 ? (
                      <div className="space-y-4">
                        {summaryceptionLayers.map((layer) => (
                          <section key={layer.layerIndex} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-4">
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <h3 className="text-xs font-bold uppercase tracking-wide text-white/75">{tt(`Layer ${layer.layerIndex}`, `第 ${layer.layerIndex} 层`)}</h3>
                                <p className="mt-0.5 text-[10px] text-white/35">
                                  {layer.layerIndex === 0 ? tt("Fresh compacted chat sentences", "最新的压缩聊天句子") : tt(`Folded sentences promoted from layer ${layer.layerIndex - 1}`, `从第 ${layer.layerIndex - 1} 层提升折叠的句子`)}
                                </p>
                              </div>
                              <span className="rounded-full border border-white/[0.08] bg-black/20 px-2.5 py-1 text-[10px] font-semibold text-white/40">
                                {tt(`${layer.snippets.length} snippets`, `${layer.snippets.length} 个片段`)}
                              </span>
                            </div>
                            <div className="space-y-2">
                              {layer.snippets.map((snippet) => (
                                <article key={snippet.id} className="rounded-lg border border-white/[0.05] bg-black/18 p-3">
                                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/32">
                                    <span>#{snippet.snippetOrder + 1}</span>
                                    <span>{renderSnippetSource(snippet)}</span>
                                    {snippet.mergedCount ? <span>{tt(`merged ${snippet.mergedCount} snippets`, `合并了 ${snippet.mergedCount} 个片段`)}</span> : null}
                                    {snippet.promoted ? <span>{tt("promoted seed", "提升种子")}</span> : null}
                                    <span>{tt("Updated:", "更新于：")} {formatDate(snippet.updatedAt)}</span>
                                    <div className="flex-1" />
                                    {editingSnippetId !== snippet.id && (
                                      <button
                                        onClick={() => { setEditingSnippetId(snippet.id); setSnippetDraft(snippet.text); }}
                                        className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white/80"
                                      >
                                        <Pencil className="h-3 w-3" />
                                        {tt("Edit", "编辑")}
                                      </button>
                                    )}
                                  </div>
                                  {editingSnippetId === snippet.id ? (
                                    <div className="space-y-2">
                                      <textarea
                                        value={snippetDraft}
                                        onChange={(e) => setSnippetDraft(e.target.value)}
                                        spellCheck={false}
                                        rows={4}
                                        className="w-full resize-y rounded-lg border border-white/[0.08] bg-black/25 p-2.5 text-xs leading-relaxed text-white/75 outline-none focus:border-primary/35"
                                      />
                                      <div className="flex items-center justify-end gap-2">
                                        <button
                                          onClick={() => setEditingSnippetId(null)}
                                          disabled={savingSnippet}
                                          className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
                                        >
                                          {tt("Cancel", "取消")}
                                        </button>
                                        <button
                                          onClick={() => handleSaveSnippet(snippet.id)}
                                          disabled={savingSnippet}
                                          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground transition-opacity disabled:opacity-40"
                                        >
                                          {savingSnippet ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                          {tt("Save", "保存")}
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-white/72">{snippet.text}</p>
                                  )}
                                </article>
                              ))}
                            </div>
                          </section>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-white/[0.08] bg-white/[0.02] px-5 py-12 text-center">
                        <Layers3 className="mx-auto mb-3 h-8 w-8 text-white/20" />
                        <p className="text-sm font-semibold text-white/65">{tt("No Layered Summary snippets yet", "暂无分层摘要片段")}</p>
                        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-white/35">
                          {tt("Keep playing or compress chat now.", "继续游玩或点击「压缩」。")}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-5 py-3">
            {contextTab === "memory" ? (
              <button
                onClick={handleClear}
                disabled={saving || regenerating || compacting}
                className="flex items-center gap-1.5 rounded-lg border border-red-300/15 bg-red-500/8 px-3 py-2 text-xs font-semibold text-red-200/75 transition-colors hover:bg-red-500/12 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {tt("Clear", "清空")}
              </button>
            ) : contextTab === "localdev" ? (
              <button
                onClick={handleClearSummary}
                disabled={saving || regenerating || compacting || summaryJobActive}
                className="flex items-center gap-1.5 rounded-lg border border-red-300/15 bg-red-500/8 px-3 py-2 text-xs font-semibold text-red-200/75 transition-colors hover:bg-red-500/12 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {tt("Clear", "清空")}
              </button>
            ) : <div />}
            <div className="flex items-center gap-2">
              {contextTab === "localdev" && !editingSummary && (
                <button
                  onClick={() => handleCompactSummary("localdev")}
                  disabled={saving || regenerating || compacting || loading || summaryJobActive}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-300/15 bg-emerald-500/8 px-3 py-2 text-xs font-semibold text-emerald-100/75 transition-colors hover:bg-emerald-500/12 hover:text-emerald-50 disabled:opacity-40"
                  title={tt("Compress older raw chat into the story summary while keeping recent chat visible", "把较早的原始聊天压缩进剧情摘要，同时保留最近聊天可见")}
                >
                  {compacting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                  {tt("Compress", "压缩")}
                </button>
              )}
              {contextTab === "summaryception" && (
                <button
                  onClick={() => handleCompactSummary("summaryception")}
                  disabled={saving || regenerating || compacting || loading}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-300/15 bg-emerald-500/8 px-3 py-2 text-xs font-semibold text-emerald-100/75 transition-colors hover:bg-emerald-500/12 hover:text-emerald-50 disabled:opacity-40"
                  title={tt("Compress older raw chat into Layered Summary snippets", "把较早的原始聊天压缩成分层摘要片段")}
                >
                  {compacting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers3 className="h-3.5 w-3.5" />}
                  {tt("Compress", "压缩")}
                </button>
              )}
              {contextTab === "memory" && (
                editingMemory ? (
                  <>
                    <button
                      onClick={cancelEditMemory}
                      disabled={saving || regenerating || compacting || loading}
                      className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                      {tt("Cancel", "取消")}
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving || regenerating || compacting || loading}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground transition-opacity disabled:opacity-40"
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      {tt("Save", "保存")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={handleRegenerate}
                      disabled={saving || regenerating || compacting || loading}
                      className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
                    >
                      {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {tt("Regenerate", "重新生成")}
                    </button>
                    <button
                      onClick={startEditMemory}
                      disabled={saving || regenerating || compacting || loading}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground transition-opacity disabled:opacity-40"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {tt("Edit", "编辑")}
                    </button>
                  </>
                )
              )}
              {contextTab === "localdev" && (
                editingSummary ? (
                  <>
                    <button
                      onClick={cancelEditSummary}
                      disabled={saving || regenerating || compacting || loading}
                      className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                      {tt("Cancel", "取消")}
                    </button>
                    <button
                      onClick={handleSaveSummary}
                      disabled={saving || regenerating || compacting || loading || summaryJobActive}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground transition-opacity disabled:opacity-40"
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      {tt("Save", "保存")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={handleRegenerateSummary}
                      disabled={saving || regenerating || compacting || loading || summaryJobActive || summaryPayload?.status === "updating"}
                      className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs font-semibold text-white/65 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
                    >
                      {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {tt("Regenerate", "重新生成")}
                    </button>
                    <button
                      onClick={startEditSummary}
                      disabled={saving || regenerating || compacting || loading || summaryJobActive}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground transition-opacity disabled:opacity-40"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {tt("Edit", "编辑")}
                    </button>
                  </>
                )
              )}
            </div>
          </div>
        </div>
        </div>
      </SandboxPlatformOverlay>
      <ModelPickerModal
        open={memoryModelPickerOpen}
        onClose={() => setMemoryModelPickerOpen(false)}
        selectedModel={memoryModel}
        onSelectModel={handleSelectMemoryModel}
        title={tt("Choose Memory Model", "选择记忆模型")}
        subtitle={tt("Session memory updater", "会话记忆更新器")}
        allowExternalProviderSwitch
      />
      <ModelPickerModal
        open={summaryModelPickerOpen}
        onClose={() => setSummaryModelPickerOpen(false)}
        selectedModel={summaryModel}
        onSelectModel={handleSelectSummaryModel}
        title={tt("Choose Story Summary Model", "选择剧情摘要模型")}
        subtitle={tt("Rolling story summary compactor", "滚动故事摘要压缩器")}
        allowExternalProviderSwitch
      />
      <ModelPickerModal
        open={summaryceptionModelPickerOpen}
        onClose={() => setSummaryceptionModelPickerOpen(false)}
        selectedModel={summaryceptionModel}
        onSelectModel={handleSelectSummaryceptionModel}
        title={tt("Choose Layered Summary Model", "选择分层摘要模型")}
        subtitle={tt("Layered snippet compactor", "分层片段压缩器")}
        allowExternalProviderSwitch
      />
    </>
  );
}
