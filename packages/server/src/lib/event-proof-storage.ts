import { EVENT_PROOF_ALLOWED_MIME_TYPES, EVENT_PROOF_MAX_BYTES } from "@yumina/shared";
import { copyObject, deleteObject, generateUploadUrl, getObject, headObject, isS3Configured } from "./s3.js";

export { EVENT_PROOF_ALLOWED_MIME_TYPES, EVENT_PROOF_MAX_BYTES };

export type EventProofMimeType = (typeof EVENT_PROOF_ALLOWED_MIME_TYPES)[number];

export function assertEventProofUpload(input: {
  contentType: string;
  fileSize: number;
}): asserts input is { contentType: EventProofMimeType; fileSize: number } {
  if (!isS3Configured()) throw new Error("EVENT_PROOF_STORAGE_NOT_CONFIGURED");
  if (!EVENT_PROOF_ALLOWED_MIME_TYPES.includes(input.contentType as EventProofMimeType)) {
    throw new Error("EVENT_PROOF_TYPE_NOT_ALLOWED");
  }
  if (!Number.isSafeInteger(input.fileSize) || input.fileSize <= 0 || input.fileSize > EVENT_PROOF_MAX_BYTES) {
    throw new Error("EVENT_PROOF_SIZE_NOT_ALLOWED");
  }
}

function extensionFor(contentType: EventProofMimeType): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "mp4";
}

export function buildEventProofKey(input: {
  eventId: string;
  ownerId: string;
  evidenceId: string;
  contentType: EventProofMimeType;
}): string {
  // event-proofs/ is deliberately absent from cdn.ts ALLOWED_KEY_PREFIXES.
  return `event-proofs/pending/${input.eventId}/${input.ownerId}/${input.evidenceId}.${extensionFor(input.contentType)}`;
}

export function buildSealedEventProofKey(input: {
  eventId: string;
  ownerId: string;
  evidenceId: string;
  contentType: EventProofMimeType;
}): string {
  return `event-proofs/sealed/${input.eventId}/${input.ownerId}/${input.evidenceId}.${extensionFor(input.contentType)}`;
}

export async function prepareEventProofUpload(input: {
  eventId: string;
  ownerId: string;
  evidenceId: string;
  contentType: string;
  fileSize: number;
}) {
  assertEventProofUpload(input);
  const objectKey = buildEventProofKey(input);
  return {
    objectKey,
    uploadUrl: await generateUploadUrl(objectKey, input.contentType),
  };
}

export async function verifyEventProofObject(input: {
  objectKey: string;
  expectedContentType: string;
  expectedFileSize: number;
}) {
  const head = await headObject(input.objectKey);
  if (head.contentType !== input.expectedContentType) {
    throw new Error("EVENT_PROOF_CONTENT_TYPE_MISMATCH");
  }
  if (head.contentLength !== input.expectedFileSize || head.contentLength > EVENT_PROOF_MAX_BYTES) {
    throw new Error("EVENT_PROOF_SIZE_MISMATCH");
  }
  return head;
}

export async function sealEventProofObject(input: {
  objectKey: string;
  eventId: string;
  ownerId: string;
  evidenceId: string;
  contentType: string;
  expectedFileSize: number;
}) {
  const upload = { contentType: input.contentType, fileSize: input.expectedFileSize };
  assertEventProofUpload(upload);
  const sealedKey = buildSealedEventProofKey({
    eventId: input.eventId,
    ownerId: input.ownerId,
    evidenceId: input.evidenceId,
    contentType: upload.contentType,
  });
  await copyObject(input.objectKey, sealedKey);
  const head = await verifyEventProofObject({
    objectKey: sealedKey,
    expectedContentType: upload.contentType,
    expectedFileSize: input.expectedFileSize,
  });
  return { objectKey: sealedKey, ...head };
}

export const readEventProofObject = getObject;
export const deleteEventProofObject = deleteObject;
