// Client API helpers for shared playthroughs (read-only replays of other
// players' sessions, published on a card's hub page). Mirrors the inline-fetch
// style the reviews UI uses — thin typed wrappers, callers handle their own
// loading/toast state.

import { getContentLevel } from "@/hooks/use-content-level";
import { playthroughContentLevelQuery } from "@/lib/playthrough-content-level";
import type { ContentLevel } from "@/stores/ui";

const apiBase = import.meta.env.VITE_API_URL || "";

// Limitless playthroughs only surface to viewers in Limitless content mode —
// pass the same contentLevel marker the hub list uses (server defaults to safe).
export interface PlaythroughListItem {
  id: string;
  sharerUserId: string;
  title: string;
  note: string | null;
  messageCount: number;
  ageRating: string;
  likeCount: number;
  hiddenByCreator: boolean;
  liked: boolean;
  createdAt: string;
  userName: string;
  userImage: string | null;
  userUsername: string | null;
}

export interface PlaythroughDetail {
  id: string;
  worldId: string;
  sharerUserId: string;
  title: string;
  note: string | null;
  messages: Array<Record<string, unknown>>;
  finalState: Record<string, unknown>;
  summary: string | null;
  messageCount: number;
  ageRating: string;
  likeCount: number;
  liked: boolean;
  createdAt: string;
  worldName?: string;
  worldThumbnailUrl?: string | null;
  sharer: { id: string; name: string; image: string | null; username: string | null };
}

export type PlaythroughSort = "newest" | "popular";

export async function listPlaythroughs(
  worldId: string,
  sort: PlaythroughSort = "newest",
  contentLevel: ContentLevel = getContentLevel(),
): Promise<PlaythroughListItem[]> {
  const res = await fetch(
    `${apiBase}/api/worlds/${worldId}/playthroughs?sort=${sort}${playthroughContentLevelQuery("&", contentLevel)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  return (data ?? []) as PlaythroughListItem[];
}

export async function getPlaythrough(id: string): Promise<PlaythroughDetail> {
  const res = await fetch(`${apiBase}/api/playthroughs/${id}${playthroughContentLevelQuery("?", getContentLevel())}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  return data as PlaythroughDetail;
}

export async function createPlaythrough(
  worldId: string,
  input: { sessionId: string; title: string; note?: string; visibility?: "public" | "unlisted" },
): Promise<{ id: string }> {
  const res = await fetch(`${apiBase}/api/worlds/${worldId}/playthroughs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  const { data } = await res.json();
  return data as { id: string };
}

export async function togglePlaythroughLike(id: string): Promise<{ liked: boolean; likeCount: number }> {
  const res = await fetch(`${apiBase}/api/playthroughs/${id}/like`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  return data as { liked: boolean; likeCount: number };
}

export async function deletePlaythrough(id: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/playthroughs/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function hidePlaythroughByCreator(worldId: string, id: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/worlds/${worldId}/playthroughs/${id}/by-creator`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
