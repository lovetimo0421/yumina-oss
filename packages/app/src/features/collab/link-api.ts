import { CollabError, type CollabRole } from "./collab-api";

const apiBase = import.meta.env?.VITE_API_URL || "";

/** A card's live invite link; `path` is where it opens in the app. */
export interface InviteLink {
  token: string;
  role: CollabRole;
  path: string;
}

/** What opening a link would do, for the join page. */
export interface InviteLinkPreview {
  /** Absent for a guest: the page asks again once they have signed in. */
  worldId?: string;
  worldName: string;
  thumbnailUrl: string | null;
  creatorName: string;
  role: CollabRole;
  alreadyMember: boolean;
  myRole: "owner" | CollabRole | null;
  /** The creator removed this person; joining by link is refused (REMOVED_BY_OWNER). */
  removed?: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}/api/world-collab${path}`, {
    credentials: "include",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = await res.json().catch(() => ({})) as { data?: T; error?: string; code?: string };
  if (!res.ok) throw new CollabError(body.error ?? `HTTP ${res.status}`, body.code, res.status);
  return (body.data ?? body) as T;
}

export const linkApi = {
  get: (worldId: string) => call<{ link: InviteLink | null }>(`/worlds/${worldId}/link`).then((d) => d.link),
  /** Turn the link on, or change what it grants (the address stays). */
  set: (worldId: string, role: CollabRole) =>
    call<{ link: InviteLink }>(`/worlds/${worldId}/link`, { method: "PUT", body: JSON.stringify({ role }) }).then((d) => d.link),
  reset: (worldId: string) => call<{ link: InviteLink }>(`/worlds/${worldId}/link/reset`, { method: "POST" }).then((d) => d.link),
  off: (worldId: string) => call(`/worlds/${worldId}/link`, { method: "DELETE" }),
  preview: (token: string) => call<InviteLinkPreview>(`/links/${encodeURIComponent(token)}`),
  join: (token: string) => call<{ worldId: string; role: string }>(`/links/${encodeURIComponent(token)}/join`, { method: "POST" }),
};

/** The full address to share. */
export const inviteLinkUrl = (link: InviteLink) => `${window.location.origin}${link.path}`;
