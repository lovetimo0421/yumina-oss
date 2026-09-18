const apiBase = import.meta.env.VITE_API_URL || "";

export type WorldHistorySource = "discovery" | "library";
export type WorldHistoryInteraction = "card-click" | "play-click";

interface RecordWorldHistoryClickInput {
  worldId: string;
  worldName: string;
  worldThumbnailUrl?: string | null;
  source: WorldHistorySource;
  interaction: WorldHistoryInteraction;
}

export function recordWorldHistoryClick(input: RecordWorldHistoryClickInput) {
  const worldId = input.worldId?.trim();
  const worldName = input.worldName?.trim();

  if (!worldId || !worldName) return;

  void fetch(`${apiBase}/api/users/me/history-clicks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    keepalive: true,
    body: JSON.stringify({
      worldId,
      worldName,
      worldThumbnailUrl: input.worldThumbnailUrl ?? null,
      source: input.source,
      interaction: input.interaction,
    }),
  }).catch(() => {
    // Best-effort analytics style logging; ignore failures.
  });
}
