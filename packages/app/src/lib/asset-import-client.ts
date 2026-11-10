import type { AssetImportJob } from "@yumina/shared";

export class AssetImportClientError extends Error {
  constructor(public code: string) { super(code); }
}

export interface AssetImportClient {
  list(): Promise<AssetImportJob[]>;
  detail(id: string): Promise<AssetImportJob>;
  reserve(input: { id: string; filename: string; size: number; folderId: string | null }): Promise<{ job: AssetImportJob; uploadUrl: string }>;
  uploaded(id: string): Promise<AssetImportJob>;
  start(id: string, options: { preserveFolders: boolean; conflict: "rename" | "skip" }): Promise<AssetImportJob>;
  retry(id: string): Promise<AssetImportJob>;
  dismiss(id: string): Promise<void>;
  upload(file: File, url: string, progress: (fraction: number) => void, signal: AbortSignal): Promise<void>;
}

const base = `${import.meta.env?.VITE_API_URL || ""}/api/user-assets/imports`;
async function request<T>(path: string, body?: unknown): Promise<T> {
  try {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok) throw new AssetImportClientError(result.code ?? (response.status === 401 ? "ARCHIVE_UNAUTHORIZED" : "ARCHIVE_STORAGE_ERROR"));
    return result.data as T;
  } catch (error) {
    if (error instanceof AssetImportClientError) throw error;
    throw new AssetImportClientError("ARCHIVE_NETWORK_ERROR");
  }
}

export const assetImportClient: AssetImportClient = {
  list: () => request(""),
  detail: id => request(`/${id}`),
  reserve: input => request("", input),
  uploaded: id => request(`/${id}/uploaded`, {}),
  start: (id, options) => request(`/${id}/start`, options),
  retry: id => request(`/${id}/retry`, {}),
  dismiss: id => request(`/${id}/dismiss`, {}),
  upload: (file, url, progress, signal) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = Math.min(30 * 60_000, 120_000 + Math.ceil(file.size / (1024 * 1024)) * 10_000);
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded / event.total); };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new AssetImportClientError("ARCHIVE_UPLOAD_INCOMPLETE"));
    };
    xhr.onerror = xhr.ontimeout = () => { cleanup(); reject(new AssetImportClientError("ARCHIVE_NETWORK_ERROR")); };
    xhr.onabort = () => { cleanup(); reject(new AssetImportClientError("ARCHIVE_INTERRUPTED")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { cleanup(); reject(new AssetImportClientError("ARCHIVE_INTERRUPTED")); }
    else xhr.send(file);
  }),
};
