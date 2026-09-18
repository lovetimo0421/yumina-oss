import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { Gamepad2, Loader2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useUiStore } from "@/stores/ui";
import { useFeature } from "@/edition/edition";
import { usePlayWithLanguage } from "@/hooks/use-play-with-language";

const apiBase = import.meta.env.VITE_API_URL || "";

interface RecentlyPlayedWorld {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  lastPlayedAt: string;
}

/** One row of GET /api/sessions — only the fields the shelf reads. */
interface RecentSessionRow {
  worldId: string;
  worldName: string | null;
  worldThumbnailUrl: string | null;
  updatedAt: string;
}

const MAX_RECENT_WORLDS = 5;

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/**
 * Newest world per session list. The hosted `recent-played` endpoint reads the
 * user's library (published worlds only); without a library the user's own
 * sessions are the play history, so group them by world and keep the latest.
 */
export function recentWorldsFromSessions(
  rows: readonly RecentSessionRow[],
  fallbackName: string,
): RecentlyPlayedWorld[] {
  const byWorld = new Map<string, RecentlyPlayedWorld>();
  for (const row of rows) {
    const existing = byWorld.get(row.worldId);
    if (existing && new Date(existing.lastPlayedAt).getTime() >= new Date(row.updatedAt).getTime()) continue;
    byWorld.set(row.worldId, {
      id: row.worldId,
      name: row.worldName ?? fallbackName,
      thumbnailUrl: row.worldThumbnailUrl ?? null,
      lastPlayedAt: row.updatedAt,
    });
  }
  return [...byWorld.values()]
    .sort((a, b) => new Date(b.lastPlayedAt).getTime() - new Date(a.lastPlayedAt).getTime())
    .slice(0, MAX_RECENT_WORLDS);
}

// ─── Recently Played Section ─────────────────────────────────────────

export function RecentlyPlayed() {
  const { t } = useTranslation("profile");
  const { t: tChat } = useTranslation("chat");
  const { data: session } = useSession();
  const navigate = useNavigate();
  // The hosted shelf reads the library (published worlds); the local edition
  // has no library, so it derives the shelf from the user's own sessions.
  const hasLibrary = useFeature("library");
  const [recentlyPlayed, setRecentlyPlayed] = useState<RecentlyPlayedWorld[]>([]);

  const { handlePlay, loading: playLoading } = usePlayWithLanguage({
    onNavigate: (sessionId, returnContext) =>
      navigate({
        to: "/app/chat/$sessionId",
        params: { sessionId },
        search: { moderationGroupKey: undefined, ...returnContext },
      }),
  });

  useEffect(() => {
    if (!session?.user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        if (hasLibrary) {
          const recentRes = await fetch(`${apiBase}/api/users/${session.user.id}/recent-played`, { credentials: "include" });
          if (recentRes.ok) {
            const { data } = await recentRes.json();
            if (!cancelled) setRecentlyPlayed(data);
          }
          return;
        }
        const sessionsRes = await fetch(`${apiBase}/api/sessions`, { credentials: "include" });
        if (sessionsRes.ok) {
          const { data } = await sessionsRes.json();
          if (!cancelled) {
            setRecentlyPlayed(recentWorldsFromSessions(Array.isArray(data) ? data : [], tChat("unknownWorld")));
          }
        }
      } catch {
        // silent
      }
    })();
    return () => { cancelled = true; };
  }, [session?.user?.id, hasLibrary, tChat]);

  const handlePlayWorld = (world: RecentlyPlayedWorld) => {
    void handlePlay({ id: world.id, name: world.name, thumbnailUrl: world.thumbnailUrl });
  };

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold text-main">
          <div className="h-4 w-1 rounded-full bg-gold" />
          {t("overview.recentlyPlayed")}
        </h2>
        <button
          type="button"
          onClick={() => useUiStore.getState().openSessionManager()}
          className="text-xs font-semibold text-gold/70 transition-colors hover:text-gold"
        >
          {t("overview.manageSessions")}
        </button>
      </div>

      {recentlyPlayed.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {recentlyPlayed.map((world) => (
            <div
              key={world.id}
              role="button"
              onClick={() => handlePlayWorld(world)}
              className="profile-overview-glass profile-overview-glass--soft group cursor-pointer overflow-hidden rounded-xl transition-all hover:border-gold/30"
            >
              <div className="relative aspect-[2/1] overflow-hidden">
                {world.thumbnailUrl ? (
                  <img
                    src={world.thumbnailUrl}
                    alt={world.name}
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-gold/10 to-transparent">
                    <Gamepad2 className="h-5 w-5 text-gold/30" />
                  </div>
                )}
                {playLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 className="h-5 w-5 animate-spin text-gold" />
                  </div>
                )}
              </div>
              <div className="p-2.5">
                <h4 className="truncate text-xs font-bold text-main transition-colors group-hover:text-gold">
                  {world.name}
                </h4>
                <p className="mt-0.5 text-[10px] text-sub/60">
                  {t("overview.playedAgo", { time: timeAgo(world.lastPlayedAt) })}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="profile-overview-glass profile-overview-glass--soft flex h-40 items-center justify-center rounded-2xl text-sub">
          {t("overview.noPlayHistory")}
        </div>
      )}
    </section>
  );
}
