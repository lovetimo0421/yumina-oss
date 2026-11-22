import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Loader2, Users } from "lucide-react";
import type { MultiplayerSettings } from "@yumina/shared";
import { absoluteImageUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";
import { storyRoomApi, type FriendRoom, type PublicRoom } from "./api";
import { Portrait } from "./party";
import { seatRange } from "./room-logic";
import { requestRoomOnNextPlay } from "./room-store";

/**
 * The card page's 联机 tab: what kind of table this card sets and how many
 * it seats, the one button that opens a room (story) or the card's own table
 * (rules), a public room for strangers, public rooms to walk into, friends'
 * rooms, who a player can be, and the AI seats.
 */

/** Open public rooms on this card with a free seat, most people online first. */
function usePublicRooms(worldId: string | null | undefined, enabled: boolean): PublicRoom[] {
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  useEffect(() => {
    setRooms([]);
    if (!worldId || !enabled) return;
    let alive = true;
    storyRoomApi
      .publicRooms(worldId)
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
export function MultiplayerTab({
  mp,
  cover,
  worldId,
  friendRooms,
  onPlay,
  loading,
}: {
  mp: MultiplayerSettings;
  cover: string | null | undefined;
  /** The card, for its public rooms (story mode only). */
  worldId?: string | null;
  friendRooms: readonly FriendRoom[];
  onPlay: () => void | Promise<void>;
  loading?: boolean;
}) {
  const { t } = useTranslation("common");
  const story = mp.mode === "story";
  const coverUrl = absoluteImageUrl(cover ?? null);
  const roles = story ? mp.roles : [];
  const aiNames = !story ? mp.ai.names : [];
  const publicRooms = usePublicRooms(worldId, story);
  const friendCodes = new Set(friendRooms.map((r) => r.code));
  const strangers = publicRooms.filter((r) => !friendCodes.has(r.code));
  const start = (opts?: { public?: boolean }) => {
    if (story) requestRoomOnNextPlay(opts);
    void onPlay();
  };

  return (
    <div className="flex flex-col gap-6" data-multiplayer-tab="">
      {/* The table: what kind, how many, and the one button. */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#141418]">
        {coverUrl && (
          <>
            <img src={coverUrl} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover opacity-30 blur-[2px]" />
            <div className="absolute inset-0 bg-gradient-to-r from-[#141418] via-[#141418]/85 to-[#141418]/50" />
          </>
        )}
        <div className="relative flex flex-wrap items-center gap-x-6 gap-y-4 p-5 sm:p-6">
          <div className="min-w-0 flex-1">
            <h3 className="font-serif text-xl font-black leading-tight text-[#FFF5D6]">
              {story ? t("storyRoom.tab.modeStory") : t("storyRoom.tab.modeRules")}
            </h3>
            <div className="mt-1 text-sm tabular-nums text-white/60">{seatRange(mp)} {t("storyRoom.tab.people")}</div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto">
            <button
              type="button"
              disabled={loading}
              onClick={() => start()}
              data-multiplayer-open=""
              className="inline-flex min-h-[2.75rem] w-full items-center justify-center gap-2 rounded-xl bg-[#C9A25E] px-6 text-[15px] font-bold text-[#1A1A22] transition-colors hover:bg-[#D8B26B] disabled:opacity-50 sm:w-auto"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
              {story ? t("storyRoom.tab.openRoom") : t("storyRoom.tab.openTable")}
            </button>
            {story && worldId && (
              <button
                type="button"
                disabled={loading}
                onClick={() => start({ public: true })}
                data-multiplayer-open-public=""
                className="inline-flex min-h-[2.5rem] w-full items-center justify-center rounded-xl border border-white/15 px-6 text-sm font-semibold text-white/85 transition-colors hover:border-[#C9A25E]/60 hover:text-white disabled:opacity-50 sm:w-auto"
              >
                {t("storyRoom.tab.openPublic")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Friends already playing */}
      {friendRooms.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            {t("storyRoom.tab.friendsPlaying")}
          </h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {friendRooms.slice(0, 4).map((r) => {
              const people = [{ name: r.hostName, image: r.hostImage }, ...(r.friends ?? []).filter((f) => f.name !== r.hostName)];
              return (
                <Link
                  key={r.code}
                  to="/app/room/$code"
                  params={{ code: r.code }}
                  className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition-colors hover:border-[#C9A25E]/50 hover:bg-[#C9A25E]/[0.06]"
                >
                  <span className="flex shrink-0 -space-x-3">
                    {people.slice(0, 3).map((p, i) => (
                      <Portrait key={i} src={p.image} name={p.name} className="h-11 w-11 rounded-xl border-2 border-[#1A1A1F]" monogramClassName="text-sm" />
                    ))}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-sm font-semibold text-foreground">{t("storyRoom.friendPlaying", { name: r.hostName })}</span>
                    <span className="flex items-center gap-1" aria-label={`${r.members}/${r.maxSeats}`}>
                      {Array.from({ length: Math.min(r.maxSeats, 8) }, (_, i) => (
                        <span key={i} className={cn("h-1.5 w-3 rounded-full", i < r.members ? "bg-[#C9A25E]" : "bg-white/15")} />
                      ))}
                      <span className="pl-1 text-xs tabular-nums text-muted-foreground">{r.members}/{r.maxSeats}</span>
                    </span>
                  </span>
                  <span className="shrink-0 rounded-xl bg-[#C9A25E] px-3.5 py-2 text-xs font-bold text-[#1A1A22] transition-colors group-hover:bg-[#D8B26B]">
                    {t("storyRoom.join")}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Public rooms: anyone can walk in (each pays their share, unless the host treats) */}
      {strangers.length > 0 && (
        <section className="flex flex-col gap-2.5" data-public-rooms="">
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="text-sm font-semibold text-foreground">{t("storyRoom.tab.publicRooms")}</h4>
            <Link
              to="/app/room/$code"
              params={{ code: strangers[0]!.code }}
              data-public-quick-join=""
              className="text-xs font-semibold text-[#D8B26B] transition-colors hover:text-[#F0C674]"
            >
              {t("storyRoom.tab.quickJoin")}
            </Link>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {strangers.slice(0, 6).map((r) => (
              <Link
                key={r.code}
                to="/app/room/$code"
                params={{ code: r.code }}
                className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition-colors hover:border-[#C9A25E]/50 hover:bg-[#C9A25E]/[0.06]"
              >
                <span className="flex shrink-0 -space-x-3">
                  {r.people.slice(0, 3).map((p, i) => (
                    <Portrait key={i} src={p.image} name={p.name} className="h-11 w-11 rounded-xl border-2 border-[#1A1A1F]" monogramClassName="text-sm" />
                  ))}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-semibold text-foreground">{t("storyRoom.tab.publicHost", { name: r.hostName })}</span>
                  <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                    {r.online > 0 && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                    {r.members}/{r.maxSeats}
                    <span aria-hidden>·</span>
                    {r.costMode === "split" ? t("storyRoom.costSplit") : t("storyRoom.costHost")}
                  </span>
                </span>
                <span className="shrink-0 rounded-xl bg-white/[0.08] px-3.5 py-2 text-xs font-bold text-foreground transition-colors group-hover:bg-[#C9A25E] group-hover:text-[#1A1A22]">
                  {t("storyRoom.join")}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Who you can be */}
      {roles.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h4 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
            {t("storyRoom.tab.roles")}
            {mp.rolesRequired && <span className="text-xs font-normal text-muted-foreground">{t("storyRoom.tab.rolesRequired")}</span>}
          </h4>
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-5">
            {roles.map((role) => (
              <div key={role.id} className="relative flex aspect-[3/4] flex-col justify-end overflow-hidden rounded-2xl border border-white/10" data-mp-role={role.id}>
                <Portrait src={role.image ?? null} name={role.name} seed={role.id} className="absolute inset-0 h-full w-full" monogramClassName="text-4xl opacity-80" />
                <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent" />
                <span className="relative flex flex-col gap-0.5 p-2.5">
                  <span className="truncate text-sm font-bold text-white">{role.name}</span>
                  {role.note && <span className="line-clamp-2 text-[11px] leading-snug text-white/70">{role.note}</span>}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Who fills the empty seats */}
      {aiNames.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h4 className="text-sm font-semibold text-foreground">{t("storyRoom.tab.aiSeats")}</h4>
          <div className="flex flex-wrap gap-2">
            {aiNames.map((name) => (
              <span key={name} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-1 pr-3 text-sm text-foreground/85">
                <Portrait name={name} className="h-7 w-7 rounded-full" monogramClassName="text-xs" />
                {name}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
