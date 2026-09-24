import { createHash } from "node:crypto";

export function validUploadRequestId(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}

/** Owner-scoped primary keys make retries safe even after a lost POST response. */
export function uploadOperationId(ownerId: string, kind: "file" | "folder", requestId: string) {
  const bytes = createHash("sha256").update(JSON.stringify([ownerId, kind, requestId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
