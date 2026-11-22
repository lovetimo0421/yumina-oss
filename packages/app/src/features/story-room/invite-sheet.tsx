import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { feedback } from "@/lib/feedback";
import { roomJoinUrl, storyRoomApi } from "./api";
import { useInviteSheet, type InviteTarget } from "./invite-sheet-store";
import { tableInvitePath } from "./room-logic";
import { useRoomStore } from "./room-store";
import { Portrait, SeatRow, memberPicture, type Seat } from "./party";
import { absoluteImageUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";

const apiBase = import.meta.env.VITE_API_URL || "";

/**
 * The one invite sheet: a story room's (from its seat bar or the card page)
 * and a rules table's (a card's own UI calling api.room.invite). Link with
 * copy, the short code, and friends with one tap each, Steam's grammar: the
 * button sends that invite and flips to invited.
 */
type Friend = { id: string; name: string; image: string | null; alias: string | null };

function targetLink(target: InviteTarget): { path: string; code: string } | null {
  if (target.kind === "story") return { path: new URL(roomJoinUrl(target.room.code)).pathname, code: target.room.code };
  const path = tableInvitePath(target.worldId, `rules:${target.code}`);
  return path ? { path, code: target.code } : null;
}

async function sendTableInvite(friendId: string, joinUrl: string, worldId: string): Promise<boolean> {
  const res = await fetch(`${apiBase}/api/friend-invites`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toUserIds: [friendId], joinUrl, worldId }),
  });
  const body = await res.json().catch(() => null);
  return res.ok && ((body?.data?.sent as number) ?? 0) > 0;
}

/** Mounted once in the app shell. */
export function InviteSheetHost() {
  const target = useInviteSheet((s) => s.target);
  const close = useInviteSheet((s) => s.close);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && close()}>
      {target && <InviteSheetBody target={target} />}
    </Dialog>
  );
}

function InviteSheetBody({ target }: { target: InviteTarget }) {
  const { t } = useTranslation("common");
  const link = targetLink(target);
  const fullUrl = link ? `${window.location.origin}${link.path}` : "";
  const invitedIds = useInviteSheet((s) => (link ? s.invited[link.path] : undefined));
  const markInvited = useInviteSheet((s) => s.markInvited);
  // A story room's seats follow the live room.
  const snapshot = useRoomStore((s) => (target.kind === "story" && s.room?.id === target.room.id ? s.snapshot : null));
  const seats = target.kind === "story"
    ? { taken: snapshot?.members.length ?? 1, max: snapshot?.room.maxSeats ?? target.room.maxSeats }
    : null;
  const full = seats ? seats.taken >= seats.max : false;
  // A rules table's sheet shows the card it is for, like a story room's.
  const [tableWorld, setTableWorld] = useState<{ name: string | null; cover: string | null } | null>(null);
  const tableWorldId = target.kind === "table" ? target.worldId : null;
  useEffect(() => {
    if (!tableWorldId) return;
    let alive = true;
    fetch(`${apiBase}/api/worlds/${encodeURIComponent(tableWorldId)}?preview=true`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const w = body?.data as { name?: string; thumbnailUrl?: string | null } | undefined;
        if (alive && w) setTableWorld({ name: w.name?.trim() || null, cover: absoluteImageUrl(w.thumbnailUrl ?? null) });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tableWorldId]);
  const cover = target.kind === "story" ? absoluteImageUrl(snapshot?.session.worldCover ?? null) : tableWorld?.cover ?? null;
  const worldName = target.kind === "story" ? snapshot?.session.worldName ?? null : tableWorld?.name ?? null;
  const partySeats: Seat[] | null = target.kind === "story" && snapshot
    ? snapshot.members.map((m) => ({ key: m.userId, name: m.name, image: memberPicture(m, snapshot.roles), roleName: m.roleName, host: m.role === "host", online: m.online }))
    : null;

  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [search, setSearch] = useState("");
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${apiBase}/api/follows/friends`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => alive && setFriends((body?.data as Friend[]) ?? []))
      .catch(() => alive && setFriends([]));
    return () => {
      alive = false;
    };
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = friends ?? [];
    return q ? list.filter((f) => f.name.toLowerCase().includes(q) || (f.alias ?? "").toLowerCase().includes(q)) : list;
  }, [friends, search]);

  if (!link) return null;
  const invited = new Set(invitedIds ?? []);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(fullUrl)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => feedback.error(t("storyRoom.copyFailed")));
  };

  const inviteOne = async (friendId: string) => {
    if (sendingId) return;
    setSendingId(friendId);
    try {
      const ok = target.kind === "story"
        ? ((await storyRoomApi.invite(target.room.code, [friendId]))?.sent ?? 0) > 0
        : await sendTableInvite(friendId, link.path, target.worldId);
      if (ok) markInvited(link.path, friendId);
      else feedback.error(t("friends.invitesFailed"));
    } catch {
      feedback.error(t("friends.invitesFailed"));
    } finally {
      setSendingId(null);
    }
  };

  return (
    <DialogContent
      mobileSheet
      overlayClassName="z-[10030]"
      className="z-[10031] flex max-h-[min(86dvh,40rem)] flex-col gap-0 overflow-hidden border-[#262830] bg-[#17181D] p-0 pb-[env(safe-area-inset-bottom)] sm:max-w-[25rem]"
    >
      <div className="relative shrink-0 overflow-hidden">
        {cover && (
          <>
            <img src={cover} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover opacity-55" />
            <div className="absolute inset-0 bg-gradient-to-b from-[#17181D]/30 via-[#17181D]/75 to-[#17181D]" />
          </>
        )}
        <div className={cn("relative px-5 pb-4", cover ? "pt-16" : "pt-5")}>
          <DialogTitle className="pr-10 font-serif text-xl font-black leading-tight text-[#FFF5D6]" style={cover ? { textShadow: "0 2px 12px rgba(0,0,0,0.7)" } : undefined}>
            {worldName ?? t("storyRoom.inviteTitle")}
          </DialogTitle>
          <DialogDescription className={`mt-1 text-xs tabular-nums ${full ? "text-amber-300/90" : "text-white/65"}`}>
            {worldName
              ? [t("storyRoom.inviteTitle"), seats ? t("storyRoom.seatCount", { count: seats.taken, max: seats.max }) : null].filter(Boolean).join(" · ")
              : seats ? t("storyRoom.seatCount", { count: seats.taken, max: seats.max }) : t("storyRoom.tableCode")}
          </DialogDescription>

          {partySeats && seats && <SeatRow seats={partySeats} max={seats.max} className="mt-4" />}

          <div className="mt-4 flex items-center gap-3 rounded-2xl border border-[#C9A25E]/30 bg-black/35 p-2 pl-4 backdrop-blur-sm">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/45">{t("storyRoom.roomCode")}</span>
              <span className="select-all font-mono text-[1.5rem] font-semibold leading-tight tracking-[0.2em] text-[#FFF5D6]" aria-label={t("storyRoom.roomCode")}>
                {link.code}
              </span>
            </span>
            <button
              type="button"
              onClick={copy}
              title={fullUrl}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-[#C9A25E] px-3.5 text-sm font-semibold text-[#1A1A22] transition-colors hover:bg-[#D8B26B]"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? t("storyRoom.copied") : t("storyRoom.copyLink")}
            </button>
          </div>
          <p className="mt-2 px-1 text-xs text-white/55" data-invite-anyone="">{t("storyRoom.linkAnyone")}</p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-t border-[#262830]">
        <div className="flex items-center gap-2 px-5 pb-1 pt-3">
          <span className="text-xs font-medium text-muted-foreground">{t("storyRoom.friends")}</span>
          {(friends?.length ?? 0) > 6 && (
            <label className="relative ml-auto w-40">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("friends.searchPlaceholder")}
                className="h-8 w-full rounded-lg bg-white/[0.05] pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground/40 focus:bg-white/[0.08]"
              />
            </label>
          )}
        </div>
        <div className="min-h-[7rem] flex-1 overflow-y-auto px-2 pb-3">
          {friends === null ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
            </div>
          ) : friends.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("storyRoom.noFriends")}</p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("friends.noMatches")}</p>
          ) : (
            visible.map((friend) => {
              const done = invited.has(friend.id);
              return (
                <div key={friend.id} className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-white/[0.03]">
                  <Portrait src={friend.image} name={friend.alias || friend.name} seed={friend.id} className="h-10 w-10 rounded-xl" monogramClassName="text-base" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{friend.alias || friend.name}</span>
                  {done ? (
                    <span className="flex h-9 items-center gap-1 rounded-xl px-3 text-xs font-semibold text-[#C9A25E]">
                      <Check className="h-3.5 w-3.5" />
                      {t("storyRoom.invited")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={sendingId !== null || full}
                      onClick={() => void inviteOne(friend.id)}
                      className="flex h-9 min-w-[4.5rem] items-center justify-center rounded-xl border border-[#C9A25E]/45 px-3 text-xs font-semibold text-[#C9A25E] transition-colors hover:border-[#D8B26B] hover:bg-[#C9A25E]/10 hover:text-[#D8B26B] disabled:opacity-40"
                    >
                      {sendingId === friend.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("friends.invite")}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </DialogContent>
  );
}
