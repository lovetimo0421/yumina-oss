import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { BookOpen, Check, ChevronDown, Crown, MicOff, MoreHorizontal, UserPlus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmAction } from "@/components/ui/global-confirm-dialog";
import { useSession } from "@/lib/auth-client";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { RoomApiError, storyRoomApi, type CostMode, type Member, type RoomRecap, type TurnMode } from "./api";
import { openStoryRoomInvite } from "./invite-sheet-store";
import { ROOM_SPEND_CAPS, roleChoices, roundState } from "./room-logic";
import { useRoomStore } from "./room-store";
import { useUiStore } from "@/stores/ui";
import { Portrait, memberPicture } from "./party";
import { RoomQuickPanel, RoundInline, TalkButton, useRoundView } from "./room-round-row";

const ITEM = "min-h-11 gap-2.5 rounded-lg px-3 focus:bg-gold/[0.10] focus:text-foreground";
/** How long the round waits for everyone (the host picks). */
// 0 = 不限时: the round goes when everyone is done, or someone asks.
const WINDOWS_MS = [30_000, 60_000, 120_000, 300_000, 0] as const;
/** The host's 24-hour limit on what the room's rounds cost (mushies; null = no limit). */
const MAX_FACES = 5;

export function isMuted(member: Pick<Member, "mutedUntil">, now = Date.now()): boolean {
  return member.mutedUntil != null && Date.parse(member.mutedUntil) > now;
}

/** Host first, then by join order (the server's order). */
function ordered(members: readonly Member[]): Member[] {
  return [...members].sort((a, b) => (a.role === b.role ? 0 : a.role === "host" ? -1 : 1));
}

function Face({ m, picture, acted, size = "h-7 w-7" }: { m: Member; picture?: string | null; acted?: boolean; size?: string }) {
  return (
    <span className="relative shrink-0">
      <Portrait
        src={picture ?? m.image}
        name={m.name}
        seed={m.userId}
        className={cn(size, "rounded-[10px] border", acted ? "border-[#C9A25E] ring-1 ring-[#C9A25E]/60" : "border-white/10", !m.online && "opacity-45")}
        monogramClassName="text-xs"
      />
      {m.ready ? (
        <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-[#121316] bg-emerald-500 text-[#121316]">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      ) : (
        m.online && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#121316] bg-emerald-400" />
      )}
    </span>
  );
}

/**
 * The room's slim bar over the chat, for the host and every member: who is
 * here (gold ring = acted this round, check = ready), seats, my role, invite,
 * and the one menu with the players and the room controls.
 */
export function RoomBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("common");
  const router = useRouter();
  const room = useRoomStore((s) => (s.room?.sessionId === sessionId ? s.room : null));
  const role = useRoomStore((s) => s.role);
  const snapshot = useRoomStore((s) => s.snapshot);
  const { data: auth } = useSession();
  const meId = auth?.user?.id ?? null;
  // Immersive mode pins its exit button to the top right corner; keep the menu clear of it.
  const theaterMode = useUiStore((s) => s.theaterMode);
  const recapOpen = useRoomStore((s) => s.recapOpen);
  // What the room cost over the last 24 hours, read fresh each time the host opens the menu.
  const [spent, setSpent] = useState<number | null>(null);
  // A card with its own full screen has no round strip of ours: the round
  // lives in this bar, which turns into a thin glass strip over the card.
  const compact = useRoomStore((s) => s.composer === false);
  const view = useRoundView(sessionId, compact);
  const [panelOpen, setPanelOpen] = useState(false);
  if (!room || room.status !== "open") return null;

  const snap = snapshot?.room.id === room.id ? snapshot : null;
  const members = ordered(snap?.members ?? []);
  const isHost = role === "host";
  const round = roundState({ room, members, pending: snap?.pending ?? [], meId });
  const me = members.find((m) => m.userId === meId) ?? null;
  const roles = roleChoices(snap?.roles ?? [], members, meId);
  const faces = members.slice(0, MAX_FACES);
  const code = room.code;
  const fail = (err: unknown) => {
    const reason = err instanceof RoomApiError ? err.code : "";
    feedback.error(t(
      reason === "role-taken" ? "storyRoom.errRoleTaken" : reason === "card-not-published" ? "storyRoom.errPublicUnpublished" : "storyRoom.updateFailed",
    ));
  };

  const setRole = (roleId: string | null) => storyRoomApi.setRole(code, roleId).catch(fail);
  const setTurnMode = (turnMode: TurnMode) => {
    if (turnMode !== room.turnMode) storyRoomApi.update(code, { turnMode }).catch(fail);
  };
  const setWindow = (mergeWindowMs: number) => {
    if (mergeWindowMs !== room.mergeWindowMs) storyRoomApi.update(code, { mergeWindowMs }).catch(fail);
  };
  const toggleFriends = () => storyRoomApi.update(code, { openToFriends: !room.openToFriends }).catch(fail);
  const togglePublic = () => storyRoomApi.update(code, { isPublic: !room.isPublic }).catch(fail);
  const costMode = room.costMode ?? "host";
  const setCostMode = (mode: CostMode) => {
    if (mode !== costMode) storyRoomApi.update(code, { costMode: mode }).catch(fail);
  };
  const spendCap = room.spendCap === undefined ? 5_000 : room.spendCap;
  const setSpendCap = (cap: number | null) => {
    if (cap !== spendCap) storyRoomApi.update(code, { spendCap: cap }).catch(fail);
  };
  const capLabel = (cap: number | null) =>
    cap == null ? t("storyRoom.spendCapNone") : t("storyRoom.spendCapAmount", { amount: cap.toLocaleString() });
  const onMenuOpen = (open: boolean) => {
    if (!open || !isHost) return;
    storyRoomApi.get(code).then((s) => setSpent(typeof s.spent === "number" ? s.spent : null)).catch(() => {});
  };
  const recap = snap?.recap ?? null;
  const windowLabel = (ms: number) =>
    ms <= 0
      ? t("storyRoom.windowNone")
      : ms < 60_000 ? t("storyRoom.windowSeconds", { count: ms / 1000 }) : t("storyRoom.windowMinutes", { count: ms / 60_000 });
  const mute = (m: Member, minutes: number) => storyRoomApi.mute(code, m.userId, minutes).catch(fail);
  const kick = async (m: Member) => {
    const ok = await confirmAction(t("storyRoom.kickConfirm", { name: m.name }), {
      title: t("storyRoom.kick"),
      confirmLabel: t("storyRoom.kick"),
      tone: "destructive",
    });
    if (ok) storyRoomApi.kick(code, m.userId).catch(fail);
  };
  const closeRoom = async () => {
    const ok = await confirmAction(t("storyRoom.closeConfirm"), {
      title: t("storyRoom.close"),
      confirmLabel: t("storyRoom.close"),
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await storyRoomApi.close(code);
      useRoomStore.getState().detach();
    } catch (err) {
      fail(err);
    }
  };
  const leave = async () => {
    await storyRoomApi.leave(code).catch(() => {});
    useRoomStore.getState().detach();
    void router.navigate({ to: "/app" });
  };

  const menu = (
    <DropdownMenuContent
      align="end"
      sideOffset={6}
      className="z-[10040] w-72 rounded-xl border-gold/25 bg-popover/95 p-1.5 text-foreground shadow-[0_18px_45px_rgba(0,0,0,0.5)] backdrop-blur-xl"
    >
      <DropdownMenuLabel className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
        {t("storyRoom.members")} · {t("storyRoom.seatCount", { count: members.length, max: room.maxSeats })}
      </DropdownMenuLabel>
      {members.map((m) => {
        const row = (
          <>
            <Face m={m} picture={memberPicture(m, snap?.roles ?? [])} acted={round.actedIds.includes(m.userId)} size="h-8 w-8" />
            <span className="min-w-0 flex-1 truncate">
              {m.name}
              {m.userId === meId && <span className="text-muted-foreground"> · {t("storyRoom.you")}</span>}
              {m.roleName && <span className="block truncate text-[11px] text-[#C9A25E]/90">{m.roleName}</span>}
            </span>
            {m.role === "host" && <Crown className="h-3.5 w-3.5 shrink-0 text-gold" aria-label={t("storyRoom.host")} />}
            {isMuted(m) && <MicOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("storyRoom.muted")} />}
          </>
        );
        if (!isHost || m.role === "host") {
          return (
            <div key={m.userId} className="flex min-h-11 items-center gap-2.5 px-3 text-sm">
              {row}
            </div>
          );
        }
        return (
          <DropdownMenuSub key={m.userId}>
            <DropdownMenuSubTrigger className={cn(ITEM, "text-sm")}>{row}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="z-[10041] rounded-xl border-gold/25 bg-popover/95 p-1.5">
              {isMuted(m) ? (
                <DropdownMenuItem className={ITEM} onSelect={() => void mute(m, 0)}>{t("storyRoom.unmute")}</DropdownMenuItem>
              ) : (
                <DropdownMenuItem className={ITEM} onSelect={() => void mute(m, 10)}>{t("storyRoom.mute10")}</DropdownMenuItem>
              )}
              <DropdownMenuItem className={cn(ITEM, "text-red-400 focus:text-red-400")} onSelect={() => void kick(m)}>
                {t("storyRoom.kick")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
      {isHost && (
        <>
          <DropdownMenuSeparator className="my-1 bg-white/[0.06]" />
          <DropdownMenuLabel className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{t("storyRoom.turns")}</DropdownMenuLabel>
          {(["free", "host"] as const).map((mode) => (
            <DropdownMenuItem key={mode} className={ITEM} onSelect={() => setTurnMode(mode)}>
              <span className="flex-1">{mode === "free" ? t("storyRoom.modeFree") : t("storyRoom.modeHost")}</span>
              {room.turnMode === mode && <Check className="h-4 w-4 text-gold" />}
            </DropdownMenuItem>
          ))}
          {room.turnMode === "free" && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={cn(ITEM, "text-sm")}>
                <span className="flex-1">{t("storyRoom.window")}</span>
                <span className="text-xs text-muted-foreground">{windowLabel(room.mergeWindowMs)}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="z-[10041] rounded-xl border-gold/25 bg-popover/95 p-1.5">
                {WINDOWS_MS.map((ms) => (
                  <DropdownMenuItem key={ms} className={ITEM} onSelect={() => setWindow(ms)}>
                    <span className="flex-1">{windowLabel(ms)}</span>
                    {room.mergeWindowMs === ms && <Check className="h-4 w-4 text-gold" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem className={ITEM} onSelect={(e) => { e.preventDefault(); void toggleFriends(); }}>
            <span className="flex-1">{t("storyRoom.openToFriends")}</span>
            {room.openToFriends && <Check className="h-4 w-4 text-gold" />}
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM} data-story-room-public="" onSelect={(e) => { e.preventDefault(); void togglePublic(); }}>
            <span className="min-w-0 flex-1">
              <span className="block">{t("storyRoom.public")}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{t("storyRoom.publicHint")}</span>
            </span>
            {room.isPublic && <Check className="h-4 w-4 text-gold" />}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={cn(ITEM, "text-sm")} data-story-room-cost="">
              <span className="flex-1">{t("storyRoom.cost")}</span>
              <span className="text-xs text-muted-foreground">{costMode === "split" ? t("storyRoom.costSplit") : t("storyRoom.costHost")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="z-[10041] max-w-72 rounded-xl border-gold/25 bg-popover/95 p-1.5">
              {(["host", "split"] as const).map((mode) => (
                <DropdownMenuItem key={mode} className={ITEM} onSelect={() => setCostMode(mode)}>
                  <span className="min-w-0 flex-1">
                    <span className="block">{mode === "split" ? t("storyRoom.costSplit") : t("storyRoom.costHost")}</span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">
                      {mode === "split" ? t("storyRoom.costSplitHint") : t("storyRoom.costHostHint")}
                    </span>
                  </span>
                  {costMode === mode && <Check className="h-4 w-4 shrink-0 text-gold" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={cn(ITEM, "text-sm")} data-story-room-spend="">
              <span className="min-w-0 flex-1">
                <span className="block">{t("storyRoom.spendCap")}</span>
                {spent != null && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {t("storyRoom.spendSpent", { amount: spent.toLocaleString() })}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {spendCap == null ? t("storyRoom.spendCapNone") : spendCap.toLocaleString()}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="z-[10041] rounded-xl border-gold/25 bg-popover/95 p-1.5">
              {ROOM_SPEND_CAPS.map((cap) => (
                <DropdownMenuItem key={cap ?? "none"} className={ITEM} onSelect={() => setSpendCap(cap)}>
                  <span className="flex-1">{capLabel(cap)}</span>
                  {spendCap === cap && <Check className="h-4 w-4 text-gold" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </>
      )}
      {recap && (
        <>
          <DropdownMenuSeparator className="my-1 bg-white/[0.06]" />
          <DropdownMenuItem className={ITEM} onSelect={() => useRoomStore.getState().setRecapOpen(true)}>
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">{t("storyRoom.recap")}</span>
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator className="my-1 bg-white/[0.06]" />
      {isHost ? (
        <DropdownMenuItem className={cn(ITEM, "text-red-400 focus:text-red-400")} onSelect={() => void closeRoom()}>
          {t("storyRoom.close")}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem className={cn(ITEM, "text-red-400 focus:text-red-400")} onSelect={() => void leave()}>
          {t("storyRoom.leave")}
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  );

  return (
    <div
      data-story-room-bar=""
      className={cn(
        "relative z-30 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur-xl sm:px-4",
        compact ? "border-white/[0.06] bg-black/55" : "border-[#262830] bg-[#121316]/92",
        theaterMode && "pr-14 sm:pr-16",
      )}
    >
      <DropdownMenu onOpenChange={onMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-10 min-w-0 items-center gap-2 rounded-xl pl-1 pr-2 transition-colors hover:bg-white/[0.04]"
            aria-label={t("storyRoom.members")}
          >
            <span className="flex items-center gap-1.5 sm:gap-3">
              {faces.map((m) => (
                <span key={m.userId} className="flex min-w-0 items-center gap-2">
                  <Face m={m} picture={memberPicture(m, snap?.roles ?? [])} acted={round.actedIds.includes(m.userId)} size="h-8 w-8" />
                  {members.length <= 4 && (
                    <span className={cn("hidden min-w-0 max-w-[6.5rem] flex-col text-left leading-tight", compact ? "lg:flex" : "sm:flex")}>
                      <span className="truncate text-xs font-medium text-foreground/90">{m.userId === meId ? t("storyRoom.you") : m.name}</span>
                      {m.roleName && <span className="truncate text-[10px] text-[#D8B26B]/85">{m.roleName}</span>}
                    </span>
                  )}
                </span>
              ))}
              {members.length > MAX_FACES && (
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-white/10 bg-[#1F2027] text-[10px] font-semibold text-muted-foreground">
                  +{members.length - MAX_FACES}
                </span>
              )}
            </span>
            <span className={cn("text-xs font-medium tabular-nums text-muted-foreground", compact && "hidden sm:inline")}>
              {members.length || 1}<span className="text-muted-foreground/50"> / {room.maxSeats}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>

      {roles.length > 0 && me && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "h-8 min-w-0 max-w-[9.5rem] items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors",
                compact ? "hidden sm:flex" : "flex",
                me.roleName
                  ? "border-[#C9A25E]/40 bg-[#C9A25E]/[0.08] text-[#D8B26B] hover:border-[#D8B26B]"
                  : "border-dashed border-white/20 text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="truncate">{me.roleName ?? t("storyRoom.pickRole")}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={6}
            className="z-[10040] w-64 rounded-xl border-gold/25 bg-popover/95 p-1.5 text-foreground shadow-[0_18px_45px_rgba(0,0,0,0.5)] backdrop-blur-xl"
          >
            {roles.map((r) => (
              <DropdownMenuItem key={r.id} disabled={!r.free} className={ITEM} onSelect={() => !r.mine && void setRole(r.id)}>
                <Portrait src={r.image} name={r.name} seed={r.id} className="h-9 w-9 shrink-0 rounded-lg border border-white/10" monogramClassName="text-sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.name}</span>
                  {r.holder && !r.mine && <span className="block truncate text-[11px] text-muted-foreground">{r.holder.name}</span>}
                </span>
                {r.mine && <Check className="h-4 w-4 text-gold" />}
              </DropdownMenuItem>
            ))}
            {!snap?.rolesRequired && me.roleId && (
              <>
                <DropdownMenuSeparator className="my-1 bg-white/[0.06]" />
                <DropdownMenuItem className={ITEM} onSelect={() => void setRole(null)}>{t("storyRoom.noRole")}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {compact && view ? <RoundInline sessionId={sessionId} view={view} /> : <div className="flex-1" />}
      {compact && view && <TalkButton view={view} open={panelOpen} onToggle={() => setPanelOpen((v) => !v)} />}

      {isHost && (
        <button
          type="button"
          onClick={() => openStoryRoomInvite(room)}
          aria-label={t("storyRoom.inviteFriends")}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[#C9A25E]/45 text-xs font-semibold text-[#C9A25E] transition-colors hover:border-[#D8B26B] hover:bg-[#C9A25E]/10 hover:text-[#D8B26B]",
            compact ? "w-8 justify-center sm:w-auto sm:px-3" : "px-3",
          )}
        >
          <UserPlus className="h-3.5 w-3.5" />
          <span className={cn(compact && "hidden sm:inline")}>{t("storyRoom.inviteFriends")}</span>
        </button>
      )}
      <DropdownMenu onOpenChange={onMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-gold/[0.10] hover:text-foreground data-[state=open]:bg-gold/[0.12] data-[state=open]:text-foreground"
            aria-label={t("storyRoom.title")}
          >
            <MoreHorizontal className="h-[18px] w-[18px]" />
          </button>
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
      {recapOpen && recap && <RecapPanel recap={recap} onClose={() => useRoomStore.getState().setRecapOpen(false)} />}
      {compact && view && panelOpen && !recapOpen && <RoomQuickPanel sessionId={sessionId} view={view} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}

/** 前情提要: what a player arriving mid-story reads first. Floats over the chat. */
function RecapPanel({ recap, onClose }: { recap: RoomRecap; onClose: () => void }) {
  const { t } = useTranslation("common");
  return (
    <div className="absolute inset-x-0 top-full z-30 px-3 pt-2 sm:px-4" data-story-room-recap="">
      <div className="mx-auto flex max-h-[45vh] max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#C9A25E]/30 bg-[#17181D] shadow-[0_18px_45px_rgba(0,0,0,0.6)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
          <BookOpen className="h-4 w-4 text-[#C9A25E]" />
          <span className="text-sm font-semibold text-[#D8B26B]">{t("storyRoom.recap")}</span>
          <span className="text-xs text-muted-foreground">{t("storyRoom.recapTurns", { count: recap.turns })}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("storyRoom.back")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-foreground/85">
          {recap.summary && <p className="whitespace-pre-wrap break-words">{recap.summary}</p>}
          {recap.last && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">{t("storyRoom.lastScene")}</span>
              <p className="whitespace-pre-wrap break-words">{recap.last}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
