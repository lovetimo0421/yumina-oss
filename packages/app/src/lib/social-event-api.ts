import type {
  CommunityEvent,
  SocialEventEntry,
  SocialEventMetrics,
  SocialEventParticipation,
  SocialPlatform,
} from "@/lib/community-events";

const apiBase = import.meta.env?.VITE_API_URL || "";

interface ApiEnvelope<T> {
  data: T;
  error?: string;
  message?: string;
}

export interface SocialEntryDraftInput {
  platform: SocialPlatform;
  accountHandle: string;
  postUrl: string;
  publishedAt: string;
  evidenceIds?: string[];
}

export interface SocialEntryInput extends SocialEntryDraftInput {
  evidenceIds: string[];
}

export interface PreparedEvidenceUpload {
  evidenceId: string;
  uploadUrl: string;
  headers?: Record<string, string>;
}

function entryBody(input: SocialEntryInput) {
  return {
    socialHandle: input.accountHandle,
    postUrl: input.postUrl,
    postPublishedAt: input.publishedAt,
    initialEvidenceIds: input.evidenceIds,
  };
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  let envelope: ApiEnvelope<T> | null = null;
  try {
    envelope = await response.json() as ApiEnvelope<T>;
  } catch {
    // The status text below is more useful than a JSON parse error.
  }
  if (!response.ok) {
    throw new Error(envelope?.error || envelope?.message || fallback);
  }
  return envelope?.data as T;
}

async function request<T>(path: string, init?: RequestInit, fallback = "Request failed"): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  return readJson<T>(response, fallback);
}

export async function getCommunityEvent(eventId: string, lang: string): Promise<CommunityEvent> {
  return request<CommunityEvent>(
    `/api/community/events/${eventId}?lang=${encodeURIComponent(lang)}`,
    undefined,
    "Failed to load event",
  );
}

export async function getSocialParticipation(eventId: string): Promise<SocialEventParticipation | null> {
  const response = await fetch(`${apiBase}/api/community/events/${eventId}/participation`, {
    credentials: "include",
  });
  if (response.status === 401) return null;
  return readJson<SocialEventParticipation | null>(response, "Failed to load participation");
}

export function saveSocialEntryDraft(eventId: string, input: SocialEntryDraftInput): Promise<SocialEventParticipation> {
  return request<SocialEventParticipation>(
    `/api/community/events/${eventId}/social-entries/${input.platform}/draft`,
    { method: "PUT", body: JSON.stringify({
      socialHandle: input.accountHandle,
      postUrl: input.postUrl || undefined,
      postPublishedAt: input.publishedAt || undefined,
      initialEvidenceIds: input.evidenceIds,
    }) },
    "Failed to save draft",
  );
}

export function submitSocialEntry(eventId: string, input: SocialEntryInput): Promise<SocialEventParticipation> {
  return request<SocialEventParticipation>(
    `/api/community/events/${eventId}/social-entries`,
    { method: "POST", body: JSON.stringify({ platform: input.platform, ...entryBody(input) }) },
    "Failed to submit social post",
  );
}

export function updateSocialEntry(
  eventId: string,
  entryId: string,
  input: SocialEntryInput,
): Promise<SocialEventParticipation> {
  return request<SocialEventParticipation>(
    `/api/community/events/${eventId}/social-entries/${entryId}`,
    { method: "PATCH", body: JSON.stringify(entryBody(input)) },
    "Failed to update social post",
  );
}

export async function uploadEventProof(
  eventId: string,
  file: File,
  purpose: "initial",
): Promise<string> {
  const prepared = await request<PreparedEvidenceUpload>(
    `/api/community/events/${eventId}/evidence/upload-url`,
    {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        fileSize: file.size,
        purpose,
      }),
    },
    "Failed to prepare proof upload",
  );

  const uploadResponse = await fetch(prepared.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type,
      ...prepared.headers,
    },
    body: file,
  });
  if (!uploadResponse.ok) throw new Error("Failed to upload proof");

  await request(
    `/api/community/events/${eventId}/evidence/${prepared.evidenceId}/complete`,
    { method: "POST", body: JSON.stringify({}) },
    "Failed to verify proof upload",
  );
  return prepared.evidenceId;
}

export async function deleteEventProof(eventId: string, evidenceId: string): Promise<void> {
  const response = await fetch(`${apiBase}/api/community/events/${eventId}/evidence/${evidenceId}`, {
    method: "DELETE",
    credentials: "include",
  });
  // 404/410: already deleted or expired. 409: attached to a past revision, so it
  // can never be part of a new submission either. In all three cases the id is
  // unusable and must leave the form — treating them as errors left users stuck
  // with an undeletable stale proof that also blocked submission (community
  // report 2026-07-23).
  if (!response.ok && ![404, 409, 410].includes(response.status)) {
    const envelope = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(envelope?.error || envelope?.message || "Failed to delete proof");
  }
}

export function getEventProofContentUrl(eventId: string, evidenceId: string): string {
  return `${apiBase}/api/community/events/${eventId}/evidence/${evidenceId}/content`;
}

export async function getAdminSocialEntries(
  eventId: string,
  page: number,
  queue?: "initial" | "final" | "settlement" | "completed",
): Promise<{
  entries: SocialEventEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  queueCounts: Record<"initial" | "final" | "settlement" | "completed", number>;
}> {
  const query = new URLSearchParams({ page: String(page), pageSize: "25" });
  if (queue) query.set("queue", queue);
  const response = await fetch(`${apiBase}/api/admin/events/${eventId}/social-entries?${query}`, { credentials: "include" });
  const payload = await response.json() as {
    data?: SocialEventEntry[];
    pagination?: { page: number; pageSize: number; total: number };
    queueCounts?: Record<"initial" | "final" | "settlement" | "completed", number>;
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error || "Failed to load social review queue");
  return {
    entries: payload.data ?? [],
    page: payload.pagination?.page ?? page,
    pageSize: payload.pagination?.pageSize ?? 100,
    total: payload.pagination?.total ?? payload.data?.length ?? 0,
    totalPages: Math.max(1, Math.ceil((payload.pagination?.total ?? payload.data?.length ?? 0) / (payload.pagination?.pageSize ?? 25))),
    queueCounts: payload.queueCounts ?? { initial: 0, final: 0, settlement: 0, completed: 0 },
  };
}

export function getAdminSocialEntry(eventId: string, entryId: string): Promise<SocialEventEntry & { submitterName?: string; snapshots?: unknown[]; rewardGrants?: unknown[] }> {
  return request(`/api/admin/events/${eventId}/social-entries/${entryId}`, undefined, "Failed to load social entry");
}

export function reviewAdminSocialEntry(
  eventId: string,
  entryId: string,
  input: {
    decision: "approve" | "reject" | "disqualify";
    adminComment?: string;
    overrideEligibility?: boolean;
  },
): Promise<SocialEventEntry> {
  return request(
    `/api/admin/events/${eventId}/social-entries/${entryId}/initial-review`,
    {
      method: "POST",
      body: JSON.stringify({
        decision: input.decision,
        reason: input.adminComment || undefined,
        overrideEligibility: input.overrideEligibility || undefined,
      }),
    },
    "Failed to review entry",
  );
}

export function recordAdminSocialSnapshot(
  eventId: string,
  entryId: string,
  input: {
    source: "official_link" | "unverifiable";
    metrics?: SocialEventMetrics;
    adminComment?: string;
  },
): Promise<SocialEventEntry> {
  return request(
    `/api/admin/events/${eventId}/social-entries/${entryId}/metrics-review`,
    { method: "POST", body: JSON.stringify({
      resolution: input.source === "official_link" ? "official_link_check" : input.source,
      metrics: input.metrics,
      reason: input.adminComment || undefined,
      linkStatus: input.source === "unverifiable" ? "unavailable" : "accessible",
    }) },
    "Failed to record final metrics",
  );
}

export function previewEventSettlement(eventId: string, userId: string): Promise<unknown> {
  return request(
    `/api/admin/events/${eventId}/social-settlements/${userId}/preview`,
    undefined,
    "Failed to preview settlement",
  );
}

export function finalizeEventSettlement(eventId: string, userId: string): Promise<unknown> {
  return request(
    `/api/admin/events/${eventId}/social-settlements/${userId}/finalize`,
    { method: "POST", body: JSON.stringify({}) },
    "Failed to finalize settlement",
  );
}
