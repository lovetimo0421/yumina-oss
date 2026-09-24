import { useEffect, useLayoutEffect } from "react";
import { FileText, Folder, Image, Loader2, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/lib/auth-client";
import { importProgress } from "@/lib/asset-import-task";
import { assetImportStore, useAssetImportStore } from "@/stores/asset-import";
import { useUserAssetStore } from "@/stores/user-assets";

export type { FolderUploadSelection } from "@/lib/asset-import-task";
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1) + " MB";
const secondary = "rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent";

function ProgressBar({ value, label }: { value: number; label: string }) {
  return <div role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: value + "%" }} /></div>;
}

/** Mounted in the shell, so closing the dialog or changing routes never cancels a batch. */
export function AssetUploadHost() {
  const { data: session, isPending } = useSession();
  const task = useAssetImportStore(s => s.task);
  useLayoutEffect(() => {
    if (!isPending) assetImportStore.getState().resetOwner(session?.user.id ?? null);
  }, [session?.user.id, isPending]);
  const running = task?.status === "running";
  useEffect(() => {
    if (!running) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [running]);
  if (!task || task.ownerId !== session?.user.id) return null;
  return <FolderUploadDialog />;
}

export function FolderUploadDialog() {
  const { t } = useTranslation("library");
  const task = useAssetImportStore(s => s.task);
  const open = useAssetImportStore(s => s.detailOpen);
  const storage = useUserAssetStore(s => s.storage);
  if (!task) return null;
  const actions = assetImportStore.getState();
  const { plan, parentLabel } = task.selection;
  const ready = task.status === "ready";
  const running = task.status === "running";
  const done = task.status === "complete";
  const overQuota = ready && storage.used + plan.totalBytes - task.completedBytes > storage.limit;
  const progress = importProgress(task);
  const current = plan.files.find(entry => entry.path === task.currentPath);
  const currentPercent = Math.round(Math.min(1, Math.max(0, task.progress?.fraction ?? 0)) * 100);
  const status = ready ? t("assets.uploadFolder") : running ? t("assets.uploading") : done ? t("assets.folderComplete", { count: task.completed }) : task.status === "cancelled" ? t("assets.uploadCancelled") : t("assets.folderPartial", { completed: task.completed, total: plan.files.length });
  const speed = running && task.stage === "storage" && task.progress ? mb(task.progress.bytesPerSecond) + "/s" : "";
  const hide = () => ready ? actions.dismiss() : actions.hide();
  const rows = ready ? [
    ...plan.directories.map(path => ({ path, type: "folder" })),
    ...plan.files.map(({ path, type }) => ({ path, type })),
  ].sort((a, b) => a.path.localeCompare(b.path)) : [];
  return <>
    <Dialog open={open} onOpenChange={value => { if (!value) hide(); }}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{status}</DialogTitle><DialogDescription className="break-words">{t("assets.folderSaveTo", { path: parentLabel })}</DialogDescription></DialogHeader>
        {ready ? <>
          <div className="max-h-52 overflow-auto rounded-lg border border-border bg-muted/20 p-3 text-xs">
            {rows.slice(0, 200).map(({ path, type }) => <div key={path} className="flex items-center gap-2 py-1.5" style={{ paddingLeft: Math.min(path.split("/").length - 1, 8) * 16 }}>
              {type === "folder" ? <Folder size={15} className="shrink-0 text-primary" /> : type === "image" ? <Image size={15} className="shrink-0" /> : type === "video" ? <Video size={15} className="shrink-0" /> : <FileText size={15} className="shrink-0" />}<span className="break-all">{path.split("/").at(-1)}</span>
            </div>)}
            {rows.length > 200 && <p className="py-2 text-muted-foreground">{t("assets.moreImportItems", { count: rows.length - 200 })}</p>}
            {!plan.files.length && <p>{t("assets.noImportFiles")}</p>}
          </div>
          <p className="text-xs text-muted-foreground">{t("assets.importSummary", { count: plan.files.length, size: mb(plan.totalBytes) })}</p>
          <p className="text-xs text-muted-foreground">{t("assets.keepFolderStructure")}</p>
        </> : <div className="space-y-4">
          {current && !done && <div className="space-y-2 rounded-lg bg-muted/20 p-3">
            <p className="break-all text-sm">{task.currentPath}</p>
            <p className="text-xs text-muted-foreground">{running ? t(`assets.uploadStage_${task.stage}`) : status}</p>
            <div className="flex justify-between gap-2 text-xs"><span>{t("assets.currentFile")}</span><span>{currentPercent}%</span></div>
            <ProgressBar value={currentPercent} label={t("assets.currentFile")} />
            <div className="flex justify-between gap-2 text-xs tabular-nums text-muted-foreground"><span>{mb(task.progress?.loaded ?? 0)} / {mb(current.file.size)}</span><span>{speed}</span></div>
          </div>}
          <div className="flex justify-between gap-2 text-xs"><span>{t("assets.folderProgress", { completed: task.completed, total: plan.files.length })}</span><span>{progress.percent}%</span></div>
          <ProgressBar value={progress.percent} label={t("assets.totalProgress")} />
          <p className="text-xs tabular-nums text-muted-foreground">{mb(progress.bytes)} / {mb(plan.totalBytes)}</p>
        </div>}
        {plan.skipped.length > 0 && <details className="text-xs text-muted-foreground"><summary>{t("assets.skippedImportFiles", { count: plan.skipped.length })}</summary><ul className="mt-2 max-h-24 overflow-auto space-y-1">{plan.skipped.map((path, i) => <li className="break-all" key={path + "-" + i}>{path}</li>)}</ul></details>}
        {overQuota && !done && <p role="alert" className="text-xs text-destructive">{t("assets.folderStorageExceeded")}</p>}
        {task.status === "failed" && <p role="alert" className="text-xs text-destructive">{t("assets.importRetryHint")}</p>}
        {task.failed.length > 0 && <details open className="text-xs text-destructive"><summary>{t("assets.failedImportFiles", { count: task.failed.length })}</summary><ul className="mt-2 max-h-24 overflow-auto space-y-1">{task.failed.map(path => <li className="break-all" key={path}>{path}</li>)}</ul></details>}
        {!done && <p className="text-xs text-muted-foreground">{t("assets.backgroundUploadHint")}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {running ? <><button className={secondary} onClick={actions.cancel}>{t("assets.cancelUpload")}</button><button className="rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground" onClick={actions.hide}>{t("assets.backgroundUpload")}</button></> : <>
            <button className={secondary} onClick={actions.dismiss}>{done ? t("assets.importDone") : t("assets.importCancel")}</button>
            {!done && <button disabled={overQuota || !plan.files.length} onClick={() => void actions.start()} className="rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{ready ? t("assets.startFolderImport", { count: plan.files.length }) : t("assets.retryImportFiles")}</button>}
          </>}
        </div>
      </DialogContent>
    </Dialog>
    {!open && !ready && <section aria-label={t("assets.uploadTask")} className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-40 w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl">
      <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm">{running && <Loader2 size={14} className="mr-2 inline animate-spin" />}{status}</span><button className={secondary} onClick={actions.show}>{t("assets.uploadDetails")}</button>{!running && <button onClick={actions.dismiss} aria-label={t("assets.importDone")} className="p-1"><X size={16} /></button>}</div>
      <p className="truncate text-xs text-muted-foreground">{plan.directories[0] ?? parentLabel}</p>
      <ProgressBar value={progress.percent} label={t("assets.totalProgress")} />
      <div className="flex justify-between gap-2 text-xs tabular-nums text-muted-foreground"><span>{task.completed} / {plan.files.length} · {progress.percent}%</span><span>{speed}</span></div>
    </section>}
  </>;
}
