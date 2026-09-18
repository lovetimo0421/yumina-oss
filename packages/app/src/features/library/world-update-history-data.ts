const apiBase = import.meta.env?.VITE_API_URL || "";

const publishedWorldUpdateListeners = new Set<() => void>();

export function subscribeToPublishedWorldUpdates(listener: () => void): () => void {
  publishedWorldUpdateListeners.add(listener);
  return () => { publishedWorldUpdateListeners.delete(listener); };
}

export function notifyPublishedWorldUpdate(): void {
  for (const listener of publishedWorldUpdateListeners) listener();
}

export interface WorldUpdateItem {
  id: string;
  worldId: string | null;
  title: string;
  content: string | null;
  isMajor: boolean;
  createdAt: string;
  creatorName: string | null;
}

export interface WorldUpdatePage {
  items: WorldUpdateItem[];
  canEdit: boolean;
  canCreate: boolean;
  canNotify: boolean;
  hasMore: boolean;
  nextOffset: number | null;
}

export function normalizeWorldUpdate(value: unknown): WorldUpdateItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string"
    || !item.id.trim()
    || typeof item.title !== "string"
    || !item.title.trim()
    || typeof item.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: item.id,
    worldId: typeof item.worldId === "string" && item.worldId.trim() ? item.worldId : null,
    title: item.title.trim(),
    content: typeof item.content === "string" && item.content.trim() ? item.content.trim() : null,
    isMajor: item.isMajor === true,
    createdAt: item.createdAt,
    creatorName: typeof item.creatorName === "string" && item.creatorName.trim()
      ? item.creatorName.trim()
      : null,
  };
}

export async function fetchWorldUpdatePage({
  worldId,
  offset,
  signal,
  fetcher = fetch,
  baseUrl = apiBase,
}: {
  worldId: string;
  offset: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  baseUrl?: string;
}): Promise<WorldUpdatePage> {
  const response = await fetcher(
    `${baseUrl}/api/worlds/${encodeURIComponent(worldId)}/updates?offset=${offset}`,
    { credentials: "include", signal },
  );
  if (!response.ok) throw new Error(`Update history request failed: ${response.status}`);

  const body = await response.json() as {
    data?: unknown;
    canEdit?: unknown;
    canCreate?: unknown;
    canNotify?: unknown;
    hasMore?: unknown;
    nextOffset?: unknown;
  };
  const items = Array.isArray(body.data)
    ? body.data.map(normalizeWorldUpdate).filter((item): item is WorldUpdateItem => item !== null)
    : [];
  const hasMore = body.hasMore === true;
  const nextOffset = hasMore && typeof body.nextOffset === "number" && Number.isSafeInteger(body.nextOffset)
    ? body.nextOffset
    : null;
  return {
    items,
    canEdit: body.canEdit === true,
    canCreate: body.canCreate === true,
    canNotify: body.canNotify === true,
    hasMore: hasMore && nextOffset !== null,
    nextOffset,
  };
}

export async function createWorldUpdate({
  worldId,
  title,
  content,
  isMajor,
  notifyPlayers,
  signal,
  fetcher = fetch,
  baseUrl = apiBase,
}: {
  worldId: string;
  title: string;
  content: string | null;
  isMajor: boolean;
  notifyPlayers: boolean;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  baseUrl?: string;
}): Promise<WorldUpdateItem> {
  if (typeof notifyPlayers !== "boolean") throw new Error("notifyPlayers must be a boolean");

  const response = await fetcher(
    `${baseUrl}/api/worlds/${encodeURIComponent(worldId)}/updates`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, isMajor, notifyPlayers }),
      signal,
    },
  );
  if (!response.ok) throw new Error(`Update creation request failed: ${response.status}`);

  const body: unknown = await response.json();
  const item = body && typeof body === "object" && !Array.isArray(body)
    ? normalizeWorldUpdate((body as Record<string, unknown>).data)
    : null;
  if (!item || item.worldId !== worldId) throw new Error("Invalid update creation response");
  return item;
}

export async function saveWorldUpdate({
  worldId,
  updateId,
  title,
  content,
  signal,
  fetcher = fetch,
  baseUrl = apiBase,
}: {
  worldId: string;
  updateId: string;
  title: string;
  content: string | null;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  baseUrl?: string;
}): Promise<WorldUpdateItem> {
  const response = await fetcher(
    `${baseUrl}/api/worlds/${encodeURIComponent(worldId)}/updates/${encodeURIComponent(updateId)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
      signal,
    },
  );
  if (!response.ok) throw new Error(`Update save request failed: ${response.status}`);

  const body: unknown = await response.json();
  const item = body && typeof body === "object" && !Array.isArray(body)
    ? normalizeWorldUpdate((body as Record<string, unknown>).data)
    : null;
  if (!item || item.id !== updateId || item.worldId !== worldId) {
    throw new Error("Invalid update save response");
  }
  return item;
}
