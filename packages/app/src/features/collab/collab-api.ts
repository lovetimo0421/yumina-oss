const apiBase = import.meta.env?.VITE_API_URL || "";

export type CollabRole = "editor" | "viewer";

export interface CollabPerson {
  userId: string;
  name: string;
  username: string | null;
  image: string | null;
  role: CollabRole;
  canPublish: boolean;
  status: "pending" | "accepted";
}

export interface CollabList {
  me: { role: "owner" | CollabRole; canPublish: boolean };
  owner: { id: string; name: string; username: string | null; image: string | null } | null;
  collaborators: CollabPerson[];
  max: number;
}

export interface SharedWorld {
  id: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  status: string | null;
  updatedAt: string;
  role: CollabRole;
  canPublish: boolean;
  creatorId: string;
  creatorName: string;
  creatorUsername: string | null;
}

export class CollabError extends Error {
  constructor(message: string, public code?: string, public status?: number) { super(message); }
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

export const collabApi = {
  list: (worldId: string) => call<CollabList>(`/worlds/${worldId}`),
  invite: (worldId: string, who: { userId?: string; username?: string }, role: CollabRole, canPublish = false) =>
    call<{ userId: string; status: string; notified?: boolean }>(`/worlds/${worldId}/invite`, { method: "POST", body: JSON.stringify({ ...who, role, canPublish }) }),
  update: (worldId: string, userId: string, patch: { role?: CollabRole; canPublish?: boolean }) =>
    call(`/worlds/${worldId}/${userId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (worldId: string, userId: string) => call(`/worlds/${worldId}/${userId}`, { method: "DELETE" }),
  accept: (worldId: string) => call<{ ok: boolean }>(`/invites/${worldId}/accept`, { method: "POST" }),
  decline: (worldId: string) => call<{ ok: boolean }>(`/invites/${worldId}/decline`, { method: "POST" }),
  shared: () => call<SharedWorld[]>(`/shared`),
  mine: () => call<Record<string, number>>(`/mine`),
  /** Fire and forget: the next one replaces it anyway. */
  cursor: (worldId: string, body: { clientId: string; x?: number; y?: number; out?: boolean; sel?: string | null; view?: { x: number; y: number; zoom: number } }) => {
    void fetch(`${apiBase}/api/world-collab/worlds/${worldId}/cursor`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => undefined);
  },
  presence: (worldId: string, body: { clientId: string; focus?: Record<string, string> | null; gone?: boolean; hello?: boolean }, keepalive = false) =>
    fetch(`${apiBase}/api/world-collab/worlds/${worldId}/presence`, {
      method: "POST", credentials: "include", keepalive,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(() => undefined).catch(() => undefined),
};
