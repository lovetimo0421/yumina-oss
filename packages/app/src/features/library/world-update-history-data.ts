const apiBase = import.meta.env?.VITE_API_URL || "";

export interface WorldUpdateItem {
  id: string;
  title: string;
  content: string | null;
  isMajor: boolean;
  createdAt: string;
  creatorName: string | null;
}

export interface WorldUpdatePage {
  items: WorldUpdateItem[];
  hasMore: boolean;
  nextOffset: number | null;
}

export function normalizeWorldUpdate(value: unknown): WorldUpdateItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string"
    || typeof item.title !== "string"
    || !item.title.trim()
    || typeof item.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: item.id,
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

  const body = await response.json() as { data?: unknown; hasMore?: unknown; nextOffset?: unknown };
  const items = Array.isArray(body.data)
    ? body.data.map(normalizeWorldUpdate).filter((item): item is WorldUpdateItem => item !== null)
    : [];
  const hasMore = body.hasMore === true;
  const nextOffset = hasMore && typeof body.nextOffset === "number" && Number.isSafeInteger(body.nextOffset)
    ? body.nextOffset
    : null;
  return { items, hasMore: hasMore && nextOffset !== null, nextOffset };
}
