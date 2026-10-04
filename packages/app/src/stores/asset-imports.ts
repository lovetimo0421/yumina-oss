import { create } from "zustand";
import { ASSET_ARCHIVE_LIMITS, isAssetArchiveFilename, isAssetImportActive, type AssetImportJob } from "@yumina/shared";
import { assetImportClient, AssetImportClientError, type AssetImportClient } from "@/lib/asset-import-client";

export interface AssetImportItem {
  id: string;
  filename: string;
  folderId: string | null;
  file?: File;
  job: AssetImportJob | null;
  progress: number;
  busy: boolean;
  uploaded: boolean;
  error: string | null;
}
interface AssetImportState {
  ownerId: string | null;
  items: AssetImportItem[];
  open: boolean;
  revision: number;
  pollError: boolean;
  setOwner: (id: string | null) => Promise<void>;
  enqueue: (files: File[], folderId: string | null) => void;
  show: () => void;
  hide: () => void;
  refresh: () => Promise<void>;
  upload: (file?: File) => Promise<void>;
  start: (preserveFolders: boolean, conflict: "rename" | "skip") => Promise<void>;
  retry: () => Promise<void>;
  dismiss: () => Promise<void>;
}
const errorCode = (error: unknown) => error instanceof AssetImportClientError ? error.code : "ARCHIVE_NETWORK_ERROR";
const recovered = (job: AssetImportJob): AssetImportItem => ({
  id: job.id, filename: job.filename, folderId: job.folderId, job,
  progress: job.status === "uploading" ? 0 : 1, busy: false, uploaded: job.status !== "uploading", error: null,
});

/** Server jobs survive navigation/reloads; local file bytes are dropped after upload. */
export function createAssetImportStore(client: AssetImportClient = assetImportClient) {
  let generation = 0;
  let aborter: AbortController | undefined;
  let polling = false;
  let hydrated = false;
  return create<AssetImportState>((set, get) => {
    const update = (id: string, patch: Partial<AssetImportItem>) => set(state => ({ items: state.items.map(item => item.id === id ? { ...item, ...patch } : item) }));
    const accept = (id: string, job: AssetImportJob) => {
      const previous = get().items.find(item => item.id === id)?.job;
      update(id, { job, error: null, uploaded: job.status !== "uploading" });
      // Refresh the library when a batch settles, not on every progress poll:
      // its normal fetch shows a loading grid and would otherwise flicker.
      if (previous?.status !== job.status && ["completed", "partial", "failed"].includes(job.status)) set(state => ({ revision: state.revision + 1 }));
    };
    const command = async (action: (id: string) => Promise<AssetImportJob>) => {
      const item = get().items[0];
      if (!item || item.busy) return;
      const epoch = generation;
      update(item.id, { busy: true, error: null });
      try { const job = await action(item.id); if (epoch === generation) accept(item.id, job); }
      catch (error) { if (epoch === generation) update(item.id, { error: errorCode(error) }); }
      finally { if (epoch === generation) update(item.id, { busy: false }); }
    };
    return {
      ownerId: null, items: [], open: false, revision: 0, pollError: false,
      setOwner: async ownerId => {
        if (ownerId === get().ownerId) return;
        const epoch = ++generation;
        aborter?.abort();
        polling = false;
        hydrated = false;
        set({ ownerId, items: [], open: false, pollError: false });
        if (!ownerId) return;
        try {
          const jobs = await client.list();
          if (epoch !== generation) return;
          // Preserve files selected while the initial request was in flight.
          const known = new Set(get().items.map(item => item.id));
          set(state => ({ items: [...state.items, ...jobs.filter(job => !known.has(job.id)).map(recovered)] }));
          hydrated = true;
        } catch { /* Feature startup/auth transitions must not disturb the page. */ }
      },
      enqueue: (files, folderId) => {
        if (!get().ownerId) return;
        const pending = files.filter(file => isAssetArchiveFilename(file.name)).map(file => ({
          id: crypto.randomUUID(), filename: file.name, folderId, file, job: null,
          progress: 0, busy: false, uploaded: false,
          error: file.size > ASSET_ARCHIVE_LIMITS.compressedBytes ? "ARCHIVE_TOO_LARGE" : null,
        } satisfies AssetImportItem));
        if (!pending.length) return;
        set(state => ({ items: [...state.items, ...pending], open: true }));
        if (!get().items[0]?.job && !get().items[0]?.error) void get().upload();
      },
      show: () => set({ open: true }),
      hide: () => set({ open: false }),
      refresh: async () => {
        if (polling || !get().ownerId) return;
        const epoch = generation;
        polling = true;
        try {
          if (!hydrated) {
            const jobs = await client.list();
            if (epoch !== generation) return;
            const known = new Set(get().items.map(item => item.id));
            set(state => ({ items: [...state.items, ...jobs.filter(job => !known.has(job.id)).map(recovered)] }));
            hydrated = true;
          }
          const active = get().items.filter(item => item.job && !item.busy && isAssetImportActive(item.job.status) && item.job.status !== "uploading");
          for (const item of active) {
            const job = await client.detail(item.id);
            if (epoch !== generation) return;
            accept(item.id, job);
          }
          if (epoch === generation) set({ pollError: false });
        } catch { if (epoch === generation) set({ pollError: true }); }
        finally { if (epoch === generation) polling = false; }
      },
      upload: async replacement => {
        const item = get().items[0];
        if (!item || item.busy) return;
        const epoch = generation;
        const file = replacement ?? item.file;
        if (replacement && (replacement.name !== item.filename || item.job && replacement.size !== item.job.inputBytes)) { update(item.id, { error: "ARCHIVE_FILE_MISMATCH" }); return; }
        if (file && (file.size < 1 || file.size > ASSET_ARCHIVE_LIMITS.compressedBytes)) { update(item.id, { error: "ARCHIVE_TOO_LARGE" }); return; }
        if (!file && !item.uploaded) { update(item.id, { error: "ARCHIVE_RESELECT" }); return; }
        const controller = new AbortController();
        aborter = controller;
        update(item.id, { busy: true, error: null, ...(replacement ? { file: replacement } : {}) });
        try {
          if (!item.uploaded && file) {
            // Recover a lost acknowledgement before trying to reserve/upload again.
            if (item.job) {
              const remote = await client.detail(item.id);
              if (epoch !== generation) return;
              if (remote.status !== "uploading") { accept(item.id, remote); update(item.id, { file: undefined }); return; }
            }
            const reservation = await client.reserve({ id: item.id, filename: item.filename, size: file.size, folderId: item.folderId });
            if (epoch !== generation) return;
            accept(item.id, reservation.job);
            await client.upload(file, reservation.uploadUrl, progress => { if (epoch === generation) update(item.id, { progress }); }, controller.signal);
            if (epoch !== generation) return;
            update(item.id, { uploaded: true, progress: 1 });
          }
          const job = await client.uploaded(item.id);
          if (epoch === generation) { accept(item.id, job); update(item.id, { file: undefined }); }
        } catch (error) { if (epoch === generation) update(item.id, { error: errorCode(error) }); }
        finally { if (epoch === generation) update(item.id, { busy: false }); }
      },
      start: (preserveFolders, conflict) => command(id => client.start(id, { preserveFolders, conflict })),
      retry: () => command(id => client.retry(id)),
      dismiss: async () => {
        const item = get().items[0];
        if (!item || item.busy) return;
        const epoch = generation;
        update(item.id, { busy: true, error: null });
        try {
          if (item.job) await client.dismiss(item.id);
          if (epoch !== generation) return;
          set(state => ({ items: state.items.filter(candidate => candidate.id !== item.id), open: state.items.length > 1 }));
          if (get().items[0] && !get().items[0]!.job && !get().items[0]!.error) void get().upload();
        } catch (error) { if (epoch === generation) update(item.id, { error: errorCode(error), busy: false }); }
      },
    };
  });
}

export const useAssetImportStore = createAssetImportStore();
