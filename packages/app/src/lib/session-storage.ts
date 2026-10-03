import { mediaRequest } from "./session-media";

export interface SessionStoredValue<T = unknown> {
  value: T | null;
  version: number;
  exists: boolean;
}
export interface SessionStorageWriteOptions { expectedVersion: number }

function storagePath(sessionId: string, key: string) {
  if (!sessionId) throw new Error("No active session");
  return `session-media/session/${encodeURIComponent(sessionId)}/storage/${encodeURIComponent(key)}`;
}

export async function readSessionStorage<T = unknown>(sessionId: string, key: string, shareId?: string): Promise<SessionStoredValue<T>> {
  if (shareId) {
    const { getContentLevel } = await import("@/hooks/use-content-level");
    return mediaRequest(`playthroughs/${encodeURIComponent(shareId)}?storageKey=${encodeURIComponent(key)}&contentLevel=${getContentLevel()}`);
  }
  return mediaRequest(storagePath(sessionId, key));
}

export function writeSessionStorage<T = unknown>(sessionId: string, key: string, value: T, options: SessionStorageWriteOptions): Promise<SessionStoredValue<T>> {
  return mediaRequest(storagePath(sessionId, key), { method: "PUT", body: JSON.stringify({ value, expectedVersion: options?.expectedVersion }) });
}

export function removeSessionStorage(sessionId: string, key: string, options: SessionStorageWriteOptions): Promise<SessionStoredValue> {
  return mediaRequest(storagePath(sessionId, key), { method: "DELETE", body: JSON.stringify({ expectedVersion: options?.expectedVersion }) });
}
