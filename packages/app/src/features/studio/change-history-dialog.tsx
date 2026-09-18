import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, X, RotateCcw, Trash2, Loader2, ChevronDown, AlertTriangle } from "lucide-react";
import { FieldError } from "@/components/ui/field-error";
import type { WorldChange, WorldDiff } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { formatTimeAgo } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import { buildReviewDiffTokens } from "./lib/review-diff";
import { changeLabel, type ChangeTone } from "./lib/change-label";

const apiBase = import.meta.env.VITE_API_URL || "";

type SnapshotRow = { id: string; label: string; createdAt: string; agentRunId?: string | null; summary?: WorldChange[] };

const TONE_CLS: Record<ChangeTone, string> = {
  added: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  removed: "bg-red-500/10 text-red-400 border-red-500/30",
  modified: "bg-amber-500/10 text-amber-300 border-amber-500/30",
};

const TONE_TEXT: Record<ChangeTone, string> = {
  added: "text-emerald-400",
  removed: "text-red-400",
  modified: "text-amber-300",
};

function ChangeChips({ changes }: { changes: WorldChange[] }) {
  const { t } = useTranslation("editor");
  if (changes.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {changes.slice(0, 6).map((c, i) => {
        const lbl = changeLabel(c);
        // i18next keys are statically typed; changeLabel builds them dynamically.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tt = t as (key: string, opts?: Record<string, unknown>) => string;
        return (
          <span key={i} className={cn("rounded-full border px-2 py-0.5 text-[11px]", TONE_CLS[lbl.tone])}>
            {tt(lbl.i18nKey, { kind: tt(lbl.kindKey), name: lbl.name })}
          </span>
        );
      })}
      {changes.length > 6 && <span className="text-[11px] text-muted-foreground">+{changes.length - 6}</span>}
    </div>
  );
}

interface Props {
  worldId: string;
  onClose: () => void;
}

export function ChangeHistoryDialog({ worldId, onClose }: Props) {
  const { t, i18n } = useTranslation(["editor", "common"]);
  const [rows, setRows] = useState<SnapshotRow[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDiff, setExpandedDiff] = useState<WorldDiff | null>(null);
  const [expandedError, setExpandedError] = useState(false);
  const expandReqRef = useRef(0);
  const [confirm, setConfirm] = useState<
    | { kind: "idle" }
    | { kind: "restore"; row: SnapshotRow; diff: WorldDiff | null }
    | { kind: "delete"; row: SnapshotRow }
    | { kind: "clearAll" }
  >({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  // The snapshot list and every confirm card stay on screen when a request
  // fails, so their failures render inline rather than as a pill (R4).
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/studio/${worldId}/snapshots`, { credentials: "include" });
      if (!res.ok) throw new Error();
      const { data } = await res.json();
      setRows(data ?? []);
      setLoadFailed(false);
    } catch {
      // Never render a failed load as "no restore points" — say so instead.
      setRows([]);
      setLoadFailed(true);
    }
  }, [worldId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { confirm.kind === "idle" ? onClose() : setConfirm({ kind: "idle" }); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [confirm.kind, onClose]);

  async function fetchDiff(id: string, against: "auto" | "current"): Promise<WorldDiff | null> {
    try {
      const res = await fetch(`${apiBase}/api/studio/${worldId}/snapshots/${id}/diff?against=${against}`, { credentials: "include" });
      if (!res.ok) return null;
      const { data } = await res.json();
      return data as WorldDiff;
    } catch { return null; }
  }

  const toggleExpand = async (row: SnapshotRow) => {
    if (expandedId === row.id) { setExpandedId(null); setExpandedDiff(null); setExpandedError(false); return; }
    const reqId = ++expandReqRef.current;
    setExpandedId(row.id); setExpandedDiff(null); setExpandedError(false);
    const d = await fetchDiff(row.id, "auto");
    if (expandReqRef.current !== reqId) return; // a newer expand superseded this one
    if (d) setExpandedDiff(d);
    else setExpandedError(true); // show an error instead of spinning forever
  };

  const openRestore = async (row: SnapshotRow) => {
    setActionError(null);
    setConfirm({ kind: "restore", row, diff: null });
    const diff = await fetchDiff(row.id, "current");
    setConfirm((cur) => (cur.kind === "restore" && cur.row.id === row.id ? { ...cur, diff } : cur));
  };

  const doRestore = async (row: SnapshotRow) => {
    setBusy(true);
    setActionError(null);
    try {
      // Flush unsaved edits first so the auto "Before rollback" snapshot covers them.
      if (useEditorStore.getState().isDirty) {
        const ok = await useEditorStore.getState().saveDraft();
        if (!ok) { setActionError(t("versionHistory.restoreFailed")); return; }
      }
      const res = await fetch(`${apiBase}/api/studio/${worldId}/rollback/${row.id}`, { method: "POST", credentials: "include" });
      if (!res.ok) { setActionError(t("versionHistory.restoreFailed")); return; }
      await useEditorStore.getState().loadWorld(worldId);
      onClose();
    } finally { setBusy(false); }
  };

  const doDelete = async (row: SnapshotRow) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`${apiBase}/api/studio/${worldId}/snapshots/${row.id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { setActionError(t("studio.changeLog.deleteFailed")); return; }
      setConfirm({ kind: "idle" });
      await refresh();
    } finally { setBusy(false); }
  };

  const doClearAll = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`${apiBase}/api/studio/${worldId}/snapshots`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { setActionError(t("studio.changeLog.deleteFailed")); return; }
      setConfirm({ kind: "idle" });
      await refresh();
    } finally { setBusy(false); }
  };

  const count = rows?.length ?? 0;
  const isDirty = useEditorStore((s) => s.isDirty);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => { if (e.target === e.currentTarget && confirm.kind === "idle") onClose(); }}>
      <div className="flex w-full max-w-lg max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_60px_rgba(0,0,0,0.45)] animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            <h3 className="text-base font-semibold">{t("studio.changeLog.title")}</h3>
            <span className="text-xs text-muted-foreground">{t("studio.changeLog.restorePointCount", { count })}</span>
          </div>
          <div className="flex items-center gap-1">
            {count > 0 && (
              <button onClick={() => { setActionError(null); setConfirm({ kind: "clearAll" }); }} className="rounded-lg px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10">
                {t("studio.changeLog.clearAll")}
              </button>
            )}
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label={t("studio.changeLog.close")}><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {rows === null ? (
            <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" /></div>
          ) : loadFailed ? (
            <div className="py-10 text-center">
              <p className="text-sm text-destructive">{t("studio.changeLog.loadFailed")}</p>
              <button onClick={() => void refresh()} className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
                {t("common:action.retry")}
              </button>
            </div>
          ) : count === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("studio.changeLog.empty")}</p>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 ring-4 ring-emerald-500/15" />
                <span className="font-medium text-foreground">{t("studio.changeLog.currentVersion")}</span>
                <span className="text-xs text-muted-foreground">{t("studio.changeLog.now")}</span>
              </div>
              <ul className="space-y-2">
                {rows.map((row) => {
                  // Auto "Before rollback" / manual backups have no agentRunId. They're
                  // safety points, not editing steps — render them slim so they don't
                  // crowd the real change history.
                  const isBackup = !row.agentRunId;
                  if (isBackup) {
                    return (
                      <li key={row.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5">
                        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <RotateCcw className="h-3 w-3 shrink-0 opacity-50" />
                          <span className="truncate">{t("studio.changeLog.backupLabel")}</span>
                          <span className="shrink-0 opacity-60">· {formatTimeAgo(String(row.createdAt), i18n.language)}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button onClick={() => openRestore(row)} className="rounded-lg border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
                            {t("studio.changeLog.restore")}
                          </button>
                          <button onClick={() => { setActionError(null); setConfirm({ kind: "delete", row }); }} className="rounded-lg p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/15 hover:text-destructive" title={t("studio.changeLog.delete")}><Trash2 className="h-3 w-3" /></button>
                        </div>
                      </li>
                    );
                  }
                  return (
                    <li key={row.id} className="rounded-xl border border-border/40 bg-background/40 px-3 py-2.5 transition-colors hover:border-border hover:bg-accent/20">
                      <div className="flex items-start justify-between gap-2">
                        <button className="min-w-0 flex-1 text-left" onClick={() => toggleExpand(row)}>
                          <div className="flex items-center gap-1.5">
                            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expandedId === row.id && "rotate-180")} />
                            <span className="text-xs text-muted-foreground">{formatTimeAgo(String(row.createdAt), i18n.language)}</span>
                          </div>
                          {row.summary && <ChangeChips changes={row.summary} />}
                        </button>
                        <div className="flex shrink-0 items-center gap-1">
                          <button onClick={() => openRestore(row)} className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover">
                            <RotateCcw className="h-3 w-3" />{t("studio.changeLog.restore")}
                          </button>
                          <button onClick={() => { setActionError(null); setConfirm({ kind: "delete", row }); }} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive" title={t("studio.changeLog.delete")}><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                      {expandedId === row.id && (
                        <div className="mt-2 rounded-lg border border-border/60 bg-background p-3">
                          {expandedError
                            ? <p className="text-[11px] text-destructive">{t("studio.changeLog.loadFailed")}</p>
                            : expandedDiff === null
                              ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
                              : <DiffDetail diff={expandedDiff} />}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>

      {confirm.kind === "restore" && (
        <ConfirmCard tone="primary" icon={<RotateCcw className="h-5 w-5" />}
          title={t("studio.changeLog.restoreConfirmTitle", { time: formatTimeAgo(String(confirm.row.createdAt), i18n.language) })}
          busy={busy} confirmLabel={t("studio.changeLog.confirmRestore")} cancelLabel={t("studio.changeLog.cancel")}
          onCancel={() => setConfirm({ kind: "idle" })} onConfirm={() => doRestore(confirm.row)}>
          <p className="mt-1 text-xs text-muted-foreground">
            {confirm.diff && confirm.diff.changes.length === 0 ? t("studio.changeLog.consequenceEmpty") : t("studio.changeLog.consequenceIntro")}
          </p>
          {confirm.diff === null ? <Loader2 className="mt-2 h-4 w-4 animate-spin text-muted-foreground/60" /> : <ChangeChips changes={confirm.diff.changes} />}
          {isDirty && <p className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-400"><AlertTriangle className="h-3 w-3" />{t("studio.changeLog.unsavedWarning")}</p>}
          <p className="mt-3 rounded-lg border border-border/60 bg-background/50 px-2.5 py-2 text-[11px] text-muted-foreground">✓ {t("studio.changeLog.autoBackupNote")}</p>
          <FieldError message={actionError} />
        </ConfirmCard>
      )}
      {confirm.kind === "delete" && (
        <ConfirmCard tone="destructive" icon={<Trash2 className="h-5 w-5" />} danger busy={busy}
          title={t("studio.changeLog.deleteConfirmTitle")} confirmLabel={t("studio.changeLog.delete")} cancelLabel={t("studio.changeLog.cancel")}
          onCancel={() => setConfirm({ kind: "idle" })} onConfirm={() => doDelete(confirm.row)}>
          <p className="mt-1 text-sm text-muted-foreground">{t("studio.changeLog.deleteConfirmBody")}</p>
          <FieldError message={actionError} />
        </ConfirmCard>
      )}
      {confirm.kind === "clearAll" && (
        <ConfirmCard tone="destructive" icon={<Trash2 className="h-5 w-5" />} danger busy={busy}
          title={t("studio.changeLog.clearAllConfirmTitle")} confirmLabel={t("studio.changeLog.clearAll")} cancelLabel={t("studio.changeLog.cancel")}
          onCancel={() => setConfirm({ kind: "idle" })} onConfirm={doClearAll}>
          <p className="mt-1 text-sm text-muted-foreground">{t("studio.changeLog.clearAllConfirmBody", { count })}</p>
          <FieldError message={actionError} />
        </ConfirmCard>
      )}
    </div>
  );
}

function DiffDetail({ diff }: { diff: WorldDiff }) {
  const { t } = useTranslation("editor");
  // i18next keys are statically typed; changeLabel builds them dynamically.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tt = t as (key: string, opts?: Record<string, unknown>) => string;
  if (diff.changes.length === 0) {
    return <p className="text-[11px] text-muted-foreground">{t("studio.changeLog.noChanges")}</p>;
  }
  return (
    <div className="space-y-2.5">
      {diff.changes.map((c, i) => {
        const lbl = changeLabel(c);
        return (
          <div key={i}>
            <div className={cn("text-[11px] font-medium", TONE_TEXT[lbl.tone])}>
              {tt(lbl.i18nKey, { kind: tt(lbl.kindKey), name: lbl.name })}
            </div>
            {c.fields?.map((f, j) => (
              <div key={j} className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background/60 px-2 py-1.5 text-[11px] leading-relaxed">
                {buildReviewDiffTokens(f.before, f.after).map((tok, k) => (
                  <span key={k} className={cn(
                    tok.type === "added" && "rounded-[3px] bg-emerald-500/20 text-emerald-300",
                    tok.type === "removed" && "rounded-[3px] bg-red-500/15 text-red-300/90 line-through decoration-red-400/50",
                    tok.type !== "added" && tok.type !== "removed" && "text-muted-foreground",
                  )}>{tok.text}</span>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ConfirmCard(props: {
  title: string; children?: React.ReactNode; confirmLabel: string; cancelLabel: string;
  onConfirm: () => void; onCancel: () => void; busy?: boolean; danger?: boolean;
  tone: "primary" | "destructive"; icon: React.ReactNode;
}) {
  const cls = props.danger ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "bg-primary text-primary-foreground hover:bg-primary-hover";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-[0_18px_60px_rgba(0,0,0,0.5)] animate-in zoom-in-95 duration-200">
        <div className="flex items-start gap-3">
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", props.tone === "destructive" ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary")}>{props.icon}</div>
          <div className="min-w-0 flex-1"><h4 className="text-base font-semibold text-foreground">{props.title}</h4>{props.children}</div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={props.onCancel} disabled={props.busy} className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40">{props.cancelLabel}</button>
          <button onClick={props.onConfirm} disabled={props.busy} className={cn("flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50", cls)}>
            {props.busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
