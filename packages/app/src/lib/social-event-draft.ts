import type { SocialEntryDraftInput } from "@/lib/social-event-api";

interface StoredSocialDraft extends SocialEntryDraftInput {
  savedAt: string;
}

function key(eventId: string): string {
  return `yumina:social-event-draft:${eventId}`;
}

export function loadSocialEventDraft(eventId: string): StoredSocialDraft | null {
  try {
    const raw = localStorage.getItem(key(eventId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSocialDraft>;
    if (
      typeof parsed.platform !== "string" ||
      typeof parsed.accountHandle !== "string" ||
      typeof parsed.postUrl !== "string" ||
      typeof parsed.publishedAt !== "string"
    ) return null;
    return parsed as StoredSocialDraft;
  } catch {
    return null;
  }
}

export function saveSocialEventDraft(eventId: string, draft: SocialEntryDraftInput): void {
  try {
    // Only text and opaque evidence IDs are persisted. Files and private URLs never
    // enter localStorage.
    localStorage.setItem(key(eventId), JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
  } catch {
    // Storage can be unavailable in private browsing; server drafts still work.
  }
}

export function clearSocialEventDraft(eventId: string): void {
  try {
    localStorage.removeItem(key(eventId));
  } catch {
    // Non-critical.
  }
}
