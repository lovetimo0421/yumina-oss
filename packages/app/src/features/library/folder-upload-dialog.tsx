import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Folder, Image, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { importFolderFiles, type FolderImportPlan, type FolderImportState } from "@/lib/asset-folder-import";
import { useUserAssetStore } from "@/stores/user-assets";

export interface FolderUploadSelection {
  plan: FolderImportPlan;
  parentFolderId: string | null;
  parentLabel: string;
}

export function FolderUploadDialog({ selection, onClose, onRefresh }: {
  selection: FolderUploadSelection;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("library");
  const { plan } = selection;
  const importState = useRef<FolderImportState>({ folderIds: new Map(), completed: new Set() });
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [started, setStarted] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [attempted, setAttempted] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const [unexpectedError, setUnexpectedError] = useState(false);
  const storage = useUserAssetStore((s) => s.storage);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  const rows = useMemo(() => [
    ...plan.directories.map((path) => ({ path, type: "folder" })),
    ...plan.files.map(({ path, type }) => ({ path, type })),
  ].sort((a, b) => a.path.localeCompare(b.path)), [plan]);
  const images = plan.files.filter((entry) => entry.type === "image").length;
  const remainingBytes = plan.files.reduce((sum, entry) => sum + (importState.current.completed.has(entry.path) ? 0 : entry.file.size), 0);
  const overQuota = storage.used + remainingBytes > storage.limit;
  const done = started && completed === plan.files.length && plan.files.length > 0;

  async function start() {
    if (controller.current || overQuota || !plan.files.length) return;
    const abortController = new AbortController();
    controller.current = abortController;
    setRunning(true);
    setStopping(false);
    setStarted(true);
    setFailed([]);
    setUnexpectedError(false);
    setAttempted(importState.current.completed.size);
    try {
      const failures = await importFolderFiles(plan, importState.current, {
        parentFolderId: selection.parentFolderId ?? undefined,
        signal: abortController.signal,
        createFolder: (name, parentId) => useUserAssetStore.getState().createFolder(name, parentId, { silent: true }),
        uploadFile: (file, type, folderId) => useUserAssetStore.getState().uploadAsset(file, type, folderId, { silent: true, addToList: false }),
        onProgress: (success, attempts) => {
          if (mounted.current) { setCompleted(success); setAttempted(attempts); }
        },
      });
      if (mounted.current) setFailed(failures);
    } catch {
      if (mounted.current) setUnexpectedError(true);
    } finally {
      controller.current = null;
      if (mounted.current) {
        setRunning(false);
        setStopping(false);
        onRefresh();
      }
    }
  }
  function stopOrClose() {
    if (controller.current) { controller.current.abort(); setStopping(true); }
    else onClose();
  }
  const secondaryClass = "rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) stopOrClose(); }}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("assets.uploadFolder")}</DialogTitle>
          <DialogDescription className="break-words">{t("assets.folderSaveTo", { path: selection.parentLabel })}</DialogDescription>
        </DialogHeader>
        <div className="max-h-52 overflow-auto rounded-lg border border-border bg-muted/20 p-3 text-xs">
          {rows.slice(0, 200).map(({ path, type }) => (
            <div key={path} className="flex items-center gap-2 py-1.5" style={{ paddingLeft: Math.min(path.split("/").length - 1, 8) * 16 }} title={path}>
              {type === "folder" ? <Folder size={15} className="shrink-0 text-primary" /> : type === "image" ? <Image size={15} className="shrink-0 text-muted-foreground" /> : <FileText size={15} className="shrink-0 text-muted-foreground" />}
              <span className="break-all">{path.split("/").at(-1)}</span>
            </div>
          ))}
          {rows.length > 200 && <p className="py-2 text-muted-foreground">{t("assets.moreImportItems", { count: rows.length - 200 })}</p>}
          {!plan.files.length && <p className="text-muted-foreground">{t("assets.noImportFiles")}</p>}
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{t("assets.folderSummary", { images, texts: plan.files.length - images, size: (plan.totalBytes / (1024 * 1024)).toFixed(1) })}</p>
          <p>{t("assets.keepFolderStructure")}</p>
        </div>
        {plan.skipped.length > 0 && <details className="text-xs text-muted-foreground"><summary>{t("assets.skippedImportFiles", { count: plan.skipped.length })}</summary><ul className="mt-2 max-h-24 overflow-auto space-y-1">{plan.skipped.map((path, i) => <li className="break-all" key={`${path}-${i}`}>{path}</li>)}</ul></details>}
        {overQuota && !done && <p role="alert" className="text-xs text-destructive">{t("assets.folderStorageExceeded")}</p>}
        {unexpectedError && <p role="alert" className="text-xs text-destructive">{t("assets.uploadFailed")}</p>}
        {started && <div className="space-y-2">
          <p role="status" className="text-xs text-primary">{stopping ? t("assets.stoppingImport") : running ? t("assets.folderProgress", { completed: attempted, total: plan.files.length }) : done ? t("assets.folderComplete", { count: completed }) : t("assets.folderPartial", { completed, total: plan.files.length })}</p>
          <div role="progressbar" aria-label={t("assets.uploadFolder")} aria-valuenow={completed} aria-valuemin={0} aria-valuemax={plan.files.length} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${plan.files.length ? completed / plan.files.length * 100 : 0}%` }} /></div>
        </div>}
        {failed.length > 0 && <details open className="text-xs text-destructive"><summary>{t("assets.failedImportFiles", { count: failed.length })}</summary><ul className="mt-2 max-h-24 overflow-auto space-y-1">{failed.map((path) => <li className="break-all" key={path}>{path}</li>)}</ul></details>}
        <div className="flex justify-end gap-2">
          <button disabled={stopping} onClick={stopOrClose} className={secondaryClass}>{done ? t("assets.importDone") : t("assets.importCancel")}</button>
          {!done && <button disabled={running || overQuota || !plan.files.length} onClick={() => void start()} className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">{running && <Loader2 size={14} className="animate-spin" />}{started ? t("assets.retryImportFiles") : t("assets.startFolderImport", { count: plan.files.length })}</button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
