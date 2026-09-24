import { createStore } from "zustand/vanilla";
import { importFolderFiles, type FolderImportPlan, type FolderImportState } from "./asset-folder-import";
import type { AssetUploadStage, UploadAssetType, UploadProgress } from "./asset-upload";
import { holdReload } from "./reload-safety";

export interface FolderUploadSelection {
  plan: FolderImportPlan;
  parentFolderId: string | null;
  parentLabel: string;
}
type Status = "ready" | "running" | "cancelled" | "failed" | "complete";
export interface AssetImportTask {
  ownerId: string;
  selection: FolderUploadSelection;
  status: Status;
  completed: number;
  completedBytes: number;
  currentPath: string;
  stage: AssetUploadStage | "folders";
  progress: UploadProgress | null;
  failed: string[];
  quotaExceeded: boolean;
}
interface Dependencies {
  storage: () => { used: number; limit: number };
  createFolder: (name: string, parentId: string | undefined, signal: AbortSignal, requestId: string) => Promise<{ id: string } | null>;
  upload: (file: File, type: UploadAssetType, folderId: string | undefined, signal: AbortSignal,
    onProgress: (progress: UploadProgress) => void, onStage: (stage: AssetUploadStage) => void, requestId: string) => Promise<unknown>;
}
export interface AssetImportStore {
  task: AssetImportTask | null;
  detailOpen: boolean;
  revision: number;
  select: (selection: FolderUploadSelection, ownerId: string) => boolean;
  start: () => Promise<void>;
  cancel: () => void;
  show: () => void;
  hide: () => void;
  dismiss: () => void;
  resetOwner: (ownerId: string | null) => void;
}

/** One in-memory batch survives route changes; nothing is persisted across accounts or reloads. */
export function createAssetImportStore(deps: Dependencies) {
  let controller: AbortController | null = null;
  let importState: FolderImportState = { folderIds: new Map(), completed: new Set() };
  let generation = 0;
  let requestIds = new Map<string, string>();
  const requestId = (key: string) => {
    if (!requestIds.has(key)) requestIds.set(key, crypto.randomUUID());
    return requestIds.get(key)!;
  };
  return createStore<AssetImportStore>((set, get) => ({
    task: null, detailOpen: false, revision: 0,
    select(selection, ownerId) {
      if (get().task) { set({ detailOpen: true }); return false; }
      generation++;
      requestIds = new Map();
      importState = { folderIds: new Map(), completed: new Set() };
      set({ detailOpen: true, task: { ownerId, selection, status: "ready", completed: 0, completedBytes: 0,
        currentPath: "", stage: "folders", progress: null, failed: [], quotaExceeded: false } });
      return true;
    },
    async start() {
      const task = get().task;
      if (!task || controller || task.status === "complete" || !task.selection.plan.files.length) return;
      const { plan } = task.selection;
      const remainingBytes = plan.files.reduce((sum, entry) => sum + (importState.completed.has(entry.path) ? 0 : entry.file.size), 0);
      const storage = deps.storage();
      // Retries must reach the server: a lost response may already consume quota.
      // The prepare endpoint reconciles the request ID before checking new bytes.
      if (task.status === "ready" && storage.used + remainingBytes > storage.limit) {
        set({ task: { ...task, quotaExceeded: true } }); return;
      }
      const run = generation;
      const state = importState;
      const abort = new AbortController();
      controller = abort;
      const release = holdReload("asset-folder-import");
      const update = (patch: Partial<AssetImportTask>) => {
        if (generation === run && get().task) set({ task: { ...get().task!, ...patch } });
      };
      update({ status: "running", failed: [], quotaExceeded: false, progress: null });
      try {
        const failures = await importFolderFiles(plan, state, {
          parentFolderId: task.selection.parentFolderId ?? undefined,
          signal: abort.signal,
          onFile: (entry) => update({ currentPath: entry.path, stage: "folders", progress: null }),
          createFolder: (name, parentId) => deps.createFolder(name, parentId, abort.signal, requestId("folder:" + JSON.stringify([parentId, name]))),
          uploadFile: (file, type, folderId) => deps.upload(file, type, folderId, abort.signal,
            (progress) => { if (!abort.signal.aborted) update({ progress }); },
            (stage) => { if (!abort.signal.aborted) update({ stage }); }, requestId("file:" + get().task!.currentPath)),
          onProgress: (completed) => update({ completed,
            completedBytes: plan.files.reduce((sum, entry) => sum + (state.completed.has(entry.path) ? entry.file.size : 0), 0),
            progress: null }),
        });
        update({ failed: failures, status: state.completed.size === plan.files.length ? "complete" : abort.signal.aborted ? "cancelled" : "failed", progress: null });
      } catch {
        update({ status: abort.signal.aborted ? "cancelled" : "failed", progress: null });
      } finally {
        release();
        if (generation === run) {
          controller = null;
          set({ revision: get().revision + 1 });
        }
      }
    },
    cancel() { controller?.abort(); },
    show() { set({ detailOpen: true }); },
    hide() { set({ detailOpen: false }); },
    dismiss() {
      if (controller) { set({ detailOpen: false }); return; }
      generation++;
      importState = { folderIds: new Map(), completed: new Set() };
      set({ task: null, detailOpen: false });
    },
    resetOwner(ownerId) {
      if (get().task && get().task?.ownerId !== ownerId) {
        generation++;
        controller?.abort(); controller = null;
        importState = { folderIds: new Map(), completed: new Set() };
        set({ task: null, detailOpen: false });
      }
    },
  }));
}

export function importProgress(task: AssetImportTask) {
  const { plan } = task.selection;
  const current = plan.files.find(entry => entry.path === task.currentPath);
  const loaded = Math.min(current?.file.size ?? 0, Math.max(0, task.progress?.loaded ?? 0));
  const bytes = Math.min(plan.totalBytes, task.completedBytes + loaded);
  const percent = task.status === "complete" ? 100 : Math.min(99, Math.floor(plan.totalBytes ? bytes / plan.totalBytes * 100 : task.completed / Math.max(plan.files.length, 1) * 100));
  return { bytes, percent };
}
