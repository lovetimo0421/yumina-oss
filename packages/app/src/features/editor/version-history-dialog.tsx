import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  History,
  X,
  RotateCcw,
  Trash2,
  Loader2,
  Save,
  Check,
  AlertTriangle,
  Sparkles,
  Radio,
} from "lucide-react";
import { FieldError } from "@/components/ui/field-error";
import { useTransientFlag } from "@/hooks/use-transient-flag";
import {
  MAX_VERSIONS_PER_WORLD,
  MAX_AUTO_VERSIONS_PER_WORLD,
  MAX_VERSION_NAME_LENGTH,
  MAX_VERSION_NOTE_LENGTH,
  type WorldVersion,
} from "@yumina/shared";
import { useEditorStore } from "@/stores/editor";
import { formatTimeAgo } from "@/lib/format-time";

const apiBase = import.meta.env.VITE_API_URL || "";

type VersionListResponse = { data: WorldVersion[]; cap: number };
type AtCapErrorBody = { error: string; cap: number; oldest: { id: string; name: string; createdAt: string } };

interface VersionHistoryDialogProps {
  worldId: string;
  onClose: () => void;
}

type ConfirmState =
  | { kind: "idle" }
  | { kind: "atCap"; oldestName: string; pendingName: string; pendingNote: string | null }
  | { kind: "restore"; version: WorldVersion }
  | { kind: "makeLive"; version: WorldVersion }
  | { kind: "delete"; version: WorldVersion };

// "4月25日 23:30" / "Apr 25, 11:30 PM" — locale-aware short timestamp used as
// the default version name when the user opens the dialog.
function defaultVersionName(locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

export function VersionHistoryDialog({ worldId, onClose }: VersionHistoryDialogProps) {
  const { t, i18n } = useTranslation("editor");
  const reloadWorld = useEditorStore((s) => s.loadWorld);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const isDirty = useEditorStore((s) => s.isDirty);

  const [versions, setVersions] = useState<WorldVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(() => defaultVersionName(i18n.language));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: "idle" });
  const [makeSafetySnapshot, setMakeSafetySnapshot] = useState(true);
  // R3/R4: the form and every confirm overlay stay on screen, so the outcome
  // shows on the Save button and failures print next to the button that failed.
  const [savedAt, setSavedAt] = useState(0);
  const justSaved = useTransientFlag(savedAt);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [liveChanged, setLiveChanged] = useState(false);

  const cap = MAX_VERSIONS_PER_WORLD;
  const manualVersions = (versions ?? []).filter((v) => !v.source || v.source === "manual");
  const automaticVersions = (versions ?? []).filter((v) => v.source && v.source !== "manual");
  const used = manualVersions.length;
  const actionsBusy = saving || busyId !== null;
  const capPct = Math.min(100, Math.round((used / cap) * 100));

  const refresh = async () => {
    setLoadError(false);
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/versions`, { credentials: "include" });
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const json = (await res.json()) as VersionListResponse;
      setVersions(json.data);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  // ESC closes the modal — match other dialogs in the project.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (actionsBusy) return;
        if (confirm.kind === "idle") onClose();
        else setConfirm({ kind: "idle" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirm.kind, onClose, actionsBusy]);

  const trimmedName = name.trim();
  const canSave = !!trimmedName && !saving && busyId === null;

  async function postSave(opts: { evictOldest: boolean; nameToUse: string; noteToUse: string | null }) {
    const res = await fetch(`${apiBase}/api/worlds/${worldId}/versions`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: opts.nameToUse, note: opts.noteToUse, evictOldest: opts.evictOldest }),
    });
    if (res.status === 409) {
      const body = (await res.json()) as AtCapErrorBody;
      return { kind: "atCap" as const, oldestName: body.oldest.name };
    }
    if (!res.ok) return { kind: "error" as const };
    return { kind: "ok" as const };
  }

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Persist the editor's in-memory edits first so the snapshot reflects
      // what the user sees on screen, not the last server-side autosave.
      if (useEditorStore.getState().isDirty) {
        const ok = await saveDraft();
        if (!ok || useEditorStore.getState().isDirty) {
          setSaveError(t("versionHistory.saveFailed"));
          return;
        }
      }

      const noteToSend = note.trim() ? note.trim().slice(0, MAX_VERSION_NOTE_LENGTH) : null;
      const result = await postSave({
        evictOldest: false,
        nameToUse: trimmedName.slice(0, MAX_VERSION_NAME_LENGTH),
        noteToUse: noteToSend,
      });

      if (result.kind === "atCap") {
        setConfirmError(null);
        setConfirm({
          kind: "atCap",
          oldestName: result.oldestName,
          pendingName: trimmedName.slice(0, MAX_VERSION_NAME_LENGTH),
          pendingNote: noteToSend,
        });
        return;
      }
      if (result.kind === "error") {
        setSaveError(t("versionHistory.saveFailed"));
        return;
      }

      setSavedAt(Date.now());
      setName(defaultVersionName(i18n.language));
      setNote("");
      await refresh();
    } catch {
      setSaveError(t("versionHistory.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmAtCap = async () => {
    if (confirm.kind !== "atCap") return;
    setSaving(true);
    setConfirmError(null);
    try {
      const result = await postSave({
        evictOldest: true,
        nameToUse: confirm.pendingName,
        noteToUse: confirm.pendingNote,
      });
      if (result.kind !== "ok") {
        setConfirmError(t("versionHistory.saveFailed"));
        return;
      }
      setSavedAt(Date.now());
      setName(defaultVersionName(i18n.language));
      setNote("");
      setConfirm({ kind: "idle" });
      await refresh();
    } catch {
      setConfirmError(t("versionHistory.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (version: WorldVersion) => {
    setBusyId(version.id);
    setConfirmError(null);
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/versions/${version.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        setConfirmError(t("versionHistory.deleteFailed"));
        return;
      }
      // The row disappears from the list — nothing left to confirm.
      setConfirm({ kind: "idle" });
      await refresh();
    } catch {
      setConfirmError(t("versionHistory.deleteFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (version: WorldVersion) => {
    setBusyId(version.id);
    setConfirmError(null);
    try {
      // Only flush dirty edits when we're going to capture them in a safety
      // snapshot. If the user opted out, their unsaved edits will be discarded
      // by the restore — saving them first would just create churn.
      if (makeSafetySnapshot && useEditorStore.getState().isDirty) {
        const ok = await saveDraft();
        if (!ok || useEditorStore.getState().isDirty) {
          setConfirmError(t("versionHistory.restoreFailed"));
          return;
        }
      }

      const draftAtRequest = useEditorStore.getState().worldDraft;
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/versions/${version.id}/restore`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          safetyName: makeSafetySnapshot
            ? t("versionHistory.safetySnapshotName", { name: version.name })
            : undefined,
          skipSafetySnapshot: !makeSafetySnapshot,
        }),
      });
      if (!res.ok) {
        setConfirmError(t("versionHistory.restoreFailed"));
        return;
      }
      // The confirm overlay was the moment; the editor now shows the restored
      // world, so the dialog just gets out of the way.
      if (useEditorStore.getState().worldDraft === draftAtRequest) await reloadWorld(worldId);
      else await useEditorStore.getState().refreshWorldSchema();
      setConfirm({ kind: "idle" });
      onClose();
    } catch {
      setConfirmError(t("versionHistory.restoreFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const handleMakeLive = async (version: WorldVersion) => {
    setBusyId(version.id);
    setConfirmError(null);
    try {
      if (useEditorStore.getState().isDirty) {
        const ok = await saveDraft();
        if (!ok || useEditorStore.getState().isDirty) {
          setConfirmError(t("versionHistory.saveBeforeSwitchFailed"));
          return;
        }
      }
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/versions/${version.id}/make-live`, {
        method: "POST", credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setConfirmError(body.code === "VERSION_IN_REVIEW"
          ? t("versionHistory.withdrawBeforeSwitch") : t("versionHistory.makeLiveFailed"));
        return;
      }
      // This updates the concurrency baseline and merges any edits made while
      // the request was in flight, while retaining the current working draft.
      await useEditorStore.getState().refreshWorldSchema();
      setLiveChanged(true);
      setConfirm({ kind: "idle" });
      await refresh();
    } catch {
      setConfirmError(t("versionHistory.makeLiveFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const renderVersion = (v: WorldVersion) => (
    <VersionRow key={v.id} version={v} busy={actionsBusy} locale={i18n.language}
      onRestore={() => { setConfirmError(null); setConfirm({ kind: "restore", version: v }); }}
      onMakeLive={() => { setConfirmError(null); setConfirm({ kind: "makeLive", version: v }); }}
      onDelete={() => { setConfirmError(null); setConfirm({ kind: "delete", version: v }); }} />
  );

  const capColor = capPct >= 90 ? "bg-destructive" : capPct >= 70 ? "bg-amber-500" : "bg-primary";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget && confirm.kind === "idle" && !actionsBusy) onClose();
      }}
    >
      <div className="flex w-full max-w-2xl max-h-[88vh] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_60px_rgba(0,0,0,0.45)] animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="relative shrink-0 border-b border-border/60 px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <History className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-foreground">{t("versionHistory.title")}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("versionHistory.subtitle", { cap, automaticCap: MAX_AUTO_VERSIONS_PER_WORLD })}
              </p>
            </div>
            <button
              onClick={onClose}
              disabled={actionsBusy}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Capacity bar */}
          <div className="mt-4 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${capColor}`}
                style={{ width: `${capPct}%` }}
              />
            </div>
            <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
              {t("versionHistory.capacity", { used, cap })}
            </span>
          </div>
        </div>

        {/* Save form */}
        <div className="shrink-0 border-b border-border/60 bg-background/40 px-6 py-4">
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            {t("versionHistory.formTitle")}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("versionHistory.namePlaceholder")}
            maxLength={MAX_VERSION_NAME_LENGTH}
            className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder-muted-foreground/50 transition-colors focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("versionHistory.noteOptional")}
            maxLength={MAX_VERSION_NOTE_LENGTH}
            rows={2}
            className="mt-2 w-full resize-none rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder-muted-foreground/50 transition-colors focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {isDirty
                ? t("versionHistory.dirtyHint")
                : t("versionHistory.cleanHint")}
            </p>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="flex shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : justSaved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {saving
                ? t("versionHistory.saving")
                : justSaved
                  ? t("versionHistory.saved")
                  : t("versionHistory.saveCurrent")}
            </button>
          </div>
          <FieldError id="version-save-error" message={saveError} />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {liveChanged && <p role="status" className="mb-3 rounded-lg bg-primary/10 p-3 text-sm text-foreground">{t("versionHistory.liveChanged")}</p>}
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
            </div>
          ) : loadError ? (
            <div className="py-6 text-center">
              <p role="alert" className="text-sm text-muted-foreground">{t("versionHistory.loadFailed")}</p>
              <button onClick={refresh} className="mt-2 rounded-lg border border-border px-3 py-2 text-sm">{t("versionHistory.retry")}</button>
            </div>
          ) : versions && versions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary/70">
                <History className="h-6 w-6" />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">{t("versionHistory.emptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground max-w-xs">{t("versionHistory.empty")}</p>
            </div>
          ) : (
            <div className="space-y-5">
              {automaticVersions.length > 0 && <section>
                <h4 className="mb-3 text-xs font-semibold text-muted-foreground">{t("versionHistory.automaticTitle", { count: automaticVersions.length })}</h4>
                <ul className="space-y-2">{automaticVersions.map(renderVersion)}</ul>
              </section>}
              {manualVersions.length > 0 && <section>
                <h4 className="mb-3 text-xs font-semibold text-muted-foreground">{t("versionHistory.savedListTitle", { count: used })}</h4>
                <ul className="space-y-2">{manualVersions.map(renderVersion)}</ul>
              </section>}
            </div>
          )}
        </div>
      </div>

      {/* Confirm overlays */}
      {confirm.kind === "makeLive" && <ConfirmOverlay
        icon={<Radio className="h-5 w-5" />} tone="primary"
        title={t("versionHistory.makeLiveTitle")}
        body={t("versionHistory.makeLiveBody")}
        confirmLabel={t("versionHistory.makeLive")} cancelLabel={t("versionHistory.restoreCancel")}
        onCancel={() => setConfirm({ kind: "idle" })}
        onConfirm={() => handleMakeLive(confirm.version)} busy={busyId !== null} error={confirmError}
      />}
      {confirm.kind === "atCap" && (
        <ConfirmOverlay
          icon={<AlertTriangle className="h-5 w-5" />}
          tone="amber"
          title={t("versionHistory.atCapTitle")}
          body={t("versionHistory.atCapBody", { cap, oldestName: confirm.oldestName })}
          confirmLabel={t("versionHistory.atCapConfirm")}
          cancelLabel={t("versionHistory.atCapCancel")}
          danger
          onCancel={() => setConfirm({ kind: "idle" })}
          onConfirm={handleConfirmAtCap}
          busy={saving}
          error={confirmError}
        />
      )}
      {confirm.kind === "restore" && (
        <ConfirmOverlay
          icon={<RotateCcw className="h-5 w-5" />}
          tone="primary"
          title={t("versionHistory.restoreConfirmTitle")}
          body={
            makeSafetySnapshot && isDirty
              ? `${t("versionHistory.restoreConfirmBody")}\n\n${t("versionHistory.restoreConfirmDirtyExtra")}`
              : t("versionHistory.restoreConfirmBody")
          }
          confirmLabel={t("versionHistory.restoreConfirm")}
          cancelLabel={t("versionHistory.restoreCancel")}
          onCancel={() => setConfirm({ kind: "idle" })}
          onConfirm={() => handleRestore(confirm.version)}
          busy={busyId === confirm.version.id}
          error={confirmError}
          extra={
            <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm transition-colors hover:bg-background/70">
              <input
                type="checkbox"
                checked={makeSafetySnapshot}
                onChange={(e) => setMakeSafetySnapshot(e.target.checked)}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border bg-input accent-primary"
              />
              <span className="flex-1">
                <span className="font-medium text-foreground">
                  {t("versionHistory.safetyToggleLabel")}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t("versionHistory.safetyToggleHint", { automaticCap: MAX_AUTO_VERSIONS_PER_WORLD })}
                </span>
              </span>
            </label>
          }
        />
      )}
      {confirm.kind === "delete" && (
        <ConfirmOverlay
          icon={<Trash2 className="h-5 w-5" />}
          tone="destructive"
          title={t("versionHistory.deleteConfirmTitle")}
          body={t("versionHistory.deleteConfirmBody", { name: confirm.version.name })}
          confirmLabel={t("versionHistory.deleteConfirm")}
          cancelLabel={t("versionHistory.deleteCancel")}
          danger
          onCancel={() => setConfirm({ kind: "idle" })}
          onConfirm={() => handleDelete(confirm.version)}
          busy={busyId === confirm.version.id}
          error={confirmError}
        />
      )}
    </div>
  );
}

interface VersionRowProps {
  version: WorldVersion;
  busy: boolean;
  locale: string;
  onRestore: () => void;
  onMakeLive: () => void;
  onDelete: () => void;
}

function VersionRow({ version, busy, locale, onRestore, onMakeLive, onDelete }: VersionRowProps) {
  const { t } = useTranslation("editor");
  const relative = useMemo(() => formatTimeAgo(String(version.createdAt), locale), [version.createdAt, locale]);
  const source = version.source;
  const automatic = !!source && source !== "manual";
  const displayName = source && source !== "manual" ? t(`versionHistory.source.${source}`) : version.name;

  return (
    <li className="group rounded-xl border border-border bg-background/30 px-4 py-3 transition-all hover:border-primary/30 hover:bg-primary/[0.04]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
            <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
            {version.isLive && <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">{t("versionHistory.currentLive")}</span>}
          </div>
          <p className="mt-0.5 ml-3.5 text-xs text-muted-foreground" title={new Date(version.createdAt).toLocaleString(locale)}>{automatic ? new Date(version.createdAt).toLocaleString(locale) : relative}</p>
          {!version.isLive && <p className="mt-1 ml-3.5 text-xs text-muted-foreground">
            {t(version.source === "live" ? "versionHistory.previousPublished" : "versionHistory.notPublished")}
          </p>}
          {version.note && (
            <p className="mt-1.5 ml-3.5 text-xs text-muted-foreground/90 whitespace-pre-wrap line-clamp-2">
              {version.note}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {version.canMakeLive && !version.isLive && <button onClick={onMakeLive} disabled={busy}
            className="flex min-h-9 items-center gap-1 rounded-lg border border-primary/30 px-2.5 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40">
            <Radio className="h-3.5 w-3.5" />{t("versionHistory.makeLive")}
          </button>}
          <button
            onClick={onRestore}
            disabled={busy}
            title={t("versionHistory.restore")}
            className="flex items-center gap-1 rounded-lg border border-transparent px-2.5 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {t("versionHistory.restore")}
          </button>
          {!automatic && <button
            onClick={onDelete}
            disabled={busy}
            title={t("versionHistory.delete")}
            aria-label={t("versionHistory.delete")}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>}
        </div>
      </div>
    </li>
  );
}

interface ConfirmOverlayProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  danger?: boolean;
  icon?: React.ReactNode;
  tone?: "primary" | "destructive" | "amber";
  extra?: React.ReactNode;
  /** Failure of the confirmed action — printed here, never as a pill. */
  error?: string | null;
}

function ConfirmOverlay({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy,
  danger,
  icon,
  tone = "primary",
  extra,
  error,
}: ConfirmOverlayProps) {
  const iconBg =
    tone === "destructive" ? "bg-destructive/15 text-destructive"
    : tone === "amber" ? "bg-amber-500/15 text-amber-400"
    : "bg-primary/15 text-primary";

  const confirmCls = danger
    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
    : "bg-primary text-primary-foreground hover:bg-primary-hover";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-[0_18px_60px_rgba(0,0,0,0.5)] animate-in zoom-in-95 duration-200">
        <div className="flex items-start gap-3">
          {icon && (
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
              {icon}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h4 className="text-base font-semibold text-foreground">{title}</h4>
            <p className="mt-1.5 text-sm text-muted-foreground whitespace-pre-line">{body}</p>
          </div>
        </div>
        {extra}
        <FieldError message={error} />
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${confirmCls}`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
