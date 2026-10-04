import { useEffect, useRef, useState } from "react";
import { FileArchive, Folder, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isAssetImportActive } from "@yumina/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/lib/auth-client";
import { useAssetImportStore, type AssetImportItem } from "@/stores/asset-imports";
import { useUserAssetStore } from "@/stores/user-assets";

const RETRYABLE = new Set(["ARCHIVE_STORAGE_ERROR", "ARCHIVE_INTERRUPTED", "ARCHIVE_QUOTA_EXCEEDED"]);
const primaryClass = "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50";
const secondaryClass = "inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 py-2.5 text-sm text-foreground disabled:opacity-50";
function size(bytes: number) { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }

/** A single global host keeps the accepted mobile sheet alive across editor tabs/navigation. */
export function AssetImportDialog() {
  const { data: session, isPending } = useSession();
  const item = useAssetImportStore(state => state.items[0]);
  const open = useAssetImportStore(state => state.open);
  const setOwner = useAssetImportStore(state => state.setOwner);
  const hide = useAssetImportStore(state => state.hide);
  const refresh = useAssetImportStore(state => state.refresh);
  const userId = session?.user.id ?? null;

  useEffect(() => { if (!isPending) void setOwner(userId); }, [isPending, userId, setOwner]);
  useEffect(() => {
    if (!userId) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    const resume = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", resume);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, [userId, refresh]);

  return (
    <Dialog open={!!item && open} onOpenChange={value => { if (!value) hide(); }}>
      {item && <AssetImportPanel key={item.id} item={item} />}
    </Dialog>
  );
}

function AssetImportPanel({ item }: { item: AssetImportItem }) {
  const { t } = useTranslation(["asset-import", "library"]);
  const folders = useUserAssetStore(state => state.folders);
  const count = useAssetImportStore(state => state.items.length);
  const pollError = useAssetImportStore(state => state.pollError);
  const { start, retry, upload, dismiss, hide, refresh } = useAssetImportStore.getState();
  const [preserveFolders, setPreserveFolders] = useState(item.job?.preserveFolders ?? true);
  const [conflict, setConflict] = useState<"rename" | "skip">(item.job?.conflict ?? "rename");
  const input = useRef<HTMLInputElement>(null);
  const job = item.job;
  const ready = job?.status === "ready";
  const complete = job?.status === "completed";
  const partial = job?.status === "partial";
  const failed = job?.status === "failed";
  const expired = job?.status === "expired" || job?.status === "cancelled";
  const uploading = !job || job.status === "uploading";
  const inspecting = job?.status === "queued_inspect" || job?.status === "inspecting";
  const active = !!job && isAssetImportActive(job.status);
  const processed = job ? job.succeeded + job.skipped + job.failed : 0;
  const percent = uploading ? Math.round(item.progress * 100) : job?.fileCount ? Math.round(processed / job.fileCount * 100) : 0;
  const error = item.error ?? job?.errorCode;
  const folder = item.folderId ? folders.find(folder => folder.id === item.folderId)?.name ?? t("currentFolder") : t("library:assets.allAssets");
  const canRetry = partial || failed && RETRYABLE.has(job?.errorCode ?? "");
  const canRetryUpload = uploading && !item.busy && (error || !item.file);

  return (
    <DialogContent mobileSheet className="gap-0 bg-popover pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:max-w-[420px]">
      <div className="mx-auto mb-5 h-1 w-9 rounded-full bg-border sm:hidden" />
      <DialogHeader className="text-left">
        <DialogTitle>{complete ? t("completed") : t("title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("description")}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-3 py-5">
        <div className="rounded-xl bg-muted p-3 text-primary"><FileArchive size={22} /></div>
        <div className="min-w-0">
          <div className="break-all text-sm font-medium">{item.filename}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {job?.fileCount ? t("fileSummary", { count: job.fileCount, size: size(job.expandedBytes) }) : size(job?.inputBytes ?? item.file?.size ?? 0)}
          </div>
        </div>
      </div>
      <div className="flex items-start justify-between gap-4 border-t border-border py-3 text-sm">
        <span className="shrink-0 text-muted-foreground">{t("destination")}</span><span className="break-all text-right">{folder}</span>
      </div>
      {ready ? <>
        <label className="flex min-h-12 items-center justify-between gap-3 border-t border-border py-3 text-sm">
          {t("preserveFolders")}
          <input type="checkbox" checked={preserveFolders} onChange={event => setPreserveFolders(event.target.checked)} className="h-4 w-4 accent-primary" disabled={item.busy} />
        </label>
        {preserveFolders && job.folders.length > 0 && <div className="mb-3 grid gap-2 rounded-xl bg-muted p-3">
          {job.folders.slice(0, 5).map(folder => <div key={folder.path} className="flex items-start gap-2 text-xs">
            <Folder size={14} className="mt-0.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 break-all">{folder.path || t("currentFolder")}</span>
            <span className="shrink-0 text-muted-foreground">{t("files", { count: folder.count })}</span>
          </div>)}
          {job.folders.length > 5 && <div className="text-xs text-muted-foreground">{t("moreFolders")}</div>}
        </div>}
        <label className="flex items-center justify-between gap-3 border-t border-border py-3 text-sm">
          <span>{t("conflict")}</span>
          <select value={conflict} onChange={event => setConflict(event.target.value as "rename" | "skip")} disabled={item.busy} className="min-h-11 max-w-[55%] rounded-lg border border-border bg-muted px-2 text-base sm:text-sm">
            <option value="rename">{t("keepBoth")}</option><option value="skip">{t("skip")}</option>
          </select>
        </label>
        {job.ignoredCount > 0 && <p className="py-2 text-xs text-muted-foreground">{t("ignored", { count: job.ignoredCount })}</p>}
      </> : <div className="py-3" aria-live="polite">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-2">
            {(item.busy || active && !error) && <Loader2 size={14} className="shrink-0 animate-spin" />}
            {complete ? t("completed") : partial ? t("partial", { count: job?.failed, succeeded: job?.succeeded }) : failed || expired || error ? t("needsAttention") : inspecting ? t("inspecting") : uploading ? t("uploading") : t("processing")}
          </span>
          {!inspecting && !failed && !expired && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{uploading ? `${percent}%` : `${processed} / ${job?.fileCount ?? 0}`}</span>}
        </div>
        {!inspecting && !failed && !expired && <div role="progressbar" aria-label={t("progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="my-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} /></div>}
        <p className="mt-2 text-xs text-muted-foreground">
          {complete ? t("result", { succeeded: job.succeeded, skipped: job.skipped }) : partial ? t("retryHint") : uploading ? t("uploadHint") : failed || expired ? t("retryHint") : t("backgroundHint")}
        </p>
        {partial && <ul className="mt-3 max-h-36 space-y-2 overflow-y-auto text-xs text-destructive">
          {job.failures.map(failure => <li key={failure.path} className="break-all">{failure.path}<span className="block text-muted-foreground">{t(`errors.${failure.code}`, { defaultValue: t("errors.ARCHIVE_STORAGE_ERROR") })}</span></li>)}
        </ul>}
      </div>}
      {error && <p role="alert" className="my-2 text-sm text-destructive">{t(`errors.${error}`, { defaultValue: t("errors.ARCHIVE_STORAGE_ERROR") })}</p>}
      {expired && <p role="alert" className="my-2 text-sm text-destructive">{t("errors.ARCHIVE_EXPIRED")}</p>}
      {pollError && <button onClick={() => void refresh()} className="py-3 text-left text-xs text-destructive underline">{t("connectionLost")}</button>}
      <div className="mt-4 flex gap-2">
        {ready ? <>
          <button className={secondaryClass} onClick={() => void dismiss()} disabled={item.busy}>{t("cancel")}</button>
          <button className={primaryClass} onClick={() => void start(preserveFolders, conflict)} disabled={item.busy}>{item.busy && <Loader2 size={14} className="animate-spin" />}{t("importFiles", { count: job.fileCount })}</button>
        </> : canRetry ? <>
          <button className={secondaryClass} onClick={() => void dismiss()} disabled={item.busy}>{t("done")}</button>
          <button className={primaryClass} onClick={() => void retry()} disabled={item.busy}>{partial ? t("retryFiles", { count: job.failed }) : t("retry")}</button>
        </> : canRetryUpload ? <>
          <button className={secondaryClass} onClick={() => void dismiss()} disabled={item.busy}>{t("cancel")}</button>
          {error !== "ARCHIVE_TOO_LARGE" && <button className={primaryClass} onClick={() => item.file || item.uploaded ? void upload() : input.current?.click()}>{item.file || item.uploaded ? t("retry") : t("reselect")}</button>}
        </> : complete || failed || expired ? <button className={primaryClass} onClick={() => void dismiss()} disabled={item.busy}>{t("done")}</button>
          : <button className={primaryClass} onClick={hide}>{t("collapse")}</button>}
      </div>
      {count > 1 && <p className="mt-3 text-center text-xs text-muted-foreground">{t("remainingArchives", { count: count - 1 })}</p>}
      <input ref={input} type="file" accept=".zip,.tar,.tar.gz,.tgz" className="hidden" aria-label={t("reselect")} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
    </DialogContent>
  );
}
