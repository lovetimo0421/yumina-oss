export interface PostWorldUpdateNoteOptions {
  worldId: string;
  title: string;
  content: string;
  isMajor: boolean;
  held: boolean;
  apiBase?: string;
  fetcher?: typeof fetch;
}

export async function postWorldUpdateNote({
  worldId,
  title,
  content,
  isMajor,
  held,
  apiBase = "",
  fetcher = fetch,
}: PostWorldUpdateNoteOptions): Promise<void> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Update title is required");

  const url = held
    ? `${apiBase}/api/worlds/${encodeURIComponent(worldId)}/pending/update-note`
    : `${apiBase}/api/worlds/${encodeURIComponent(worldId)}/updates`;
  const response = await fetcher(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: normalizedTitle,
      content: content.trim() || undefined,
      isMajor,
    }),
  });

  if (!response.ok) {
    throw new Error(`Update note request failed: ${response.status}`);
  }
}
