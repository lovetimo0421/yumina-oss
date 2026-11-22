import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Loader2, Users } from "lucide-react";
import type { MultiplayerSettings } from "@yumina/shared";
import { Portrait } from "./party";
import { cn } from "@/lib/utils";
import { storyRoomApi, type FriendRoom } from "./api";
import { seatRange } from "./room-logic";
import { requestRoomOnNextPlay } from "./room-store";

/** "联机 · 2–6 人" on a card its author opened for playing together. */
export function MultiplayerBadge({ mp, className, onClick }: { mp: MultiplayerSettings | null | undefined; className?: string; onClick?: () => void }) {
  const { t } = useTranslation("common");
  if (!mp?.enabled) return null;
  const look = cn(
    "inline-flex items-center gap-1.5 rounded-full border border-[#C9A25E]/55 bg-black/35 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-[#D8B26B] backdrop-blur-sm",
    onClick && "transition-colors hover:border-[#D8B26B] hover:bg-[#C9A25E]/15",
    className,
  );
  const body = (
    <>
      <Users className="h-3 w-3" aria-hidden />
      {t("storyRoom.badge", { seats: seatRange(mp) })}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={look} data-multiplayer-badge="">
      {body}
    </button>
  ) : (
    <span className={look}>{body}</span>
  );
}

/**
 * The card page's second play button. Story mode: starts play like Play and
 * the chat that opens next opens the room with its invite sheet. Rules mode:
 * just starts play (the card's own interface seats the table).
 */
export function PlayWithFriendsButton({
  mp,
  onPlay,
  loading,
  className,
}: {
  mp: MultiplayerSettings | null | undefined;
  onPlay: () => void | Promise<void>;
  loading?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("common");
  if (!mp?.enabled) return null;
  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => {
        if (mp.mode === "story") requestRoomOnNextPlay();
        void onPlay();
      }}
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-[#C9A25E]/55 bg-[#C9A25E]/[0.06] px-4 text-sm font-semibold text-[#C9A25E] transition-colors hover:border-[#D8B26B] hover:bg-[#C9A25E]/[0.12] hover:text-[#D8B26B] disabled:opacity-50",
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Users className="h-4 w-4 shrink-0" />}
      {t("storyRoom.playWithFriends")}
    </button>
  );
}

const apiBase = import.meta.env.VITE_API_URL || "";
const settingCache = new Map<string, MultiplayerSettings | null>();

/** The card's multiplayer setting for surfaces whose list rows do not carry it (the library). */
export function useCardMultiplayer(worldId: string | null | undefined, enabled = true): MultiplayerSettings | null {
  const [mp, setMp] = useState<MultiplayerSettings | null>(() => (worldId ? settingCache.get(worldId) ?? null : null));
  useEffect(() => {
    if (!worldId || !enabled) {
      setMp(null);
      return;
    }
    if (settingCache.has(worldId)) {
      setMp(settingCache.get(worldId) ?? null);
      return;
    }
    let alive = true;
    fetch(`${apiBase}/api/worlds/${encodeURIComponent(worldId)}?preview=true`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const value = (body?.data?.multiplayer as MultiplayerSettings | null | undefined) ?? null;
        settingCache.set(worldId, value);
        if (alive) setMp(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [worldId, enabled]);
  return mp;
}

/** Open rooms on this card that a friend is in and lets friends walk into. */
export function useFriendRooms(worldId: string | null | undefined, enabled: boolean): FriendRoom[] {
  const [rooms, setRooms] = useState<FriendRoom[]>([]);
  useEffect(() => {
    setRooms([]);
    if (!worldId || !enabled) return;
    let alive = true;
    storyRoomApi
      .friendRooms(worldId)
      .then((list) => {
        if (alive && Array.isArray(list)) setRooms(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [worldId, enabled]);
  return rooms;
}

/** 「Ann 在玩 · 2/6 加入」: walk into a friend's room on this card. */
export function FriendRoomsBar({
  worldId,
  mp,
  className,
}: {
  worldId: string | null | undefined;
  mp: MultiplayerSettings | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation("common");
  const rooms = useFriendRooms(worldId, !!mp?.enabled && mp.mode === "story");
  if (!rooms.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} data-friend-rooms="">
      {rooms.slice(0, 3).map((r) => (
        <Link
          key={r.code}
          to="/app/room/$code"
          params={{ code: r.code }}
          className="group inline-flex min-w-0 max-w-full items-center gap-3 rounded-2xl border border-[#C9A25E]/35 bg-gradient-to-r from-[#C9A25E]/[0.12] to-transparent py-1.5 pl-1.5 pr-2 text-xs text-foreground/85 transition-colors hover:border-[#D8B26B]"
        >
          <span className="flex shrink-0 -space-x-2">
            {[{ name: r.hostName, image: r.hostImage }, ...(r.friends ?? []).filter((f) => f.name !== r.hostName)].slice(0, 3).map((p, i) => (
              <Portrait key={i} src={p.image} name={p.name} className="h-8 w-8 rounded-[10px] border-2 border-[#17181D]" monogramClassName="text-xs" />
            ))}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[13px] font-semibold text-foreground">{t("storyRoom.friendPlaying", { name: r.hostName })}</span>
            <span className="flex items-center gap-1 pt-0.5" aria-label={`${r.members}/${r.maxSeats}`}>
              {Array.from({ length: Math.min(r.maxSeats, 8) }, (_, i) => (
                <span key={i} className={cn("h-1.5 w-3 rounded-full", i < r.members ? "bg-[#C9A25E]" : "bg-white/15")} />
              ))}
              <span className="pl-1 tabular-nums text-muted-foreground">{r.members}/{r.maxSeats}</span>
            </span>
          </span>
          <span className="ml-1 shrink-0 rounded-xl bg-[#C9A25E] px-3 py-1.5 text-xs font-bold text-[#1A1A22] transition-colors group-hover:bg-[#D8B26B]">{t("storyRoom.join")}</span>
        </Link>
      ))}
    </div>
  );
}
