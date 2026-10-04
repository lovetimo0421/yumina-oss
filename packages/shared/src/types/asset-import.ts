/** Shared by the archive importer and its progress UI. Limits apply before extraction. */
export const ASSET_ARCHIVE_LIMITS = {
  compressedBytes: 128 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  files: 2000,
  depth: 16,
} as const;

export function isAssetArchiveFilename(filename: string): boolean {
  return /\.(zip|tar|tar\.gz|tgz)$/i.test(filename);
}

export type AssetImportStatus =
  | "uploading" | "queued_inspect" | "inspecting" | "ready"
  | "queued" | "processing" | "completed" | "partial" | "failed"
  | "cancelled" | "expired";

export interface AssetImportJob {
  id: string;
  filename: string;
  folderId: string | null;
  status: AssetImportStatus;
  inputBytes: number;
  expandedBytes: number;
  fileCount: number;
  ignoredCount: number;
  succeeded: number;
  skipped: number;
  failed: number;
  preserveFolders: boolean;
  conflict: "rename" | "skip";
  errorCode: string | null;
  /** First 50 failing paths; counts above always cover the complete job. */
  failures: { path: string; code: string }[];
  /** Compact directory preview, never a list of file contents. */
  folders: { path: string; count: number }[];
  expiresAt: string;
  updatedAt: string;
}

export const isAssetImportActive = (status: AssetImportStatus): boolean =>
  ["uploading", "queued_inspect", "inspecting", "queued", "processing"].includes(status);
