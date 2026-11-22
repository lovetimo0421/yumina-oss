import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Check, MessageCircle, PenLine, X } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat";
import { RoomApiError, storyRoomApi, ACTION_MAX_CHARS, TALK_MAX_CHARS } from "./api";
import { storyRoomUI, typingIds, type StoryRoomUI } from "./room-logic";
import { raiseRoomCapAndSend, routeSendToRoom, sendRoomNow, sendRoomTyping, useRoomStore } from "./room-store";
import { Portrait } from "./party";
import { useNow } from "./use-now";

/**
 * For a card that draws its own full screen (no platform composer, so no
 * round strip inside it), the round lives in the room bar itself: what the
 * round is doing, the countdown along the bar's edge, 我好了 / 让 AI 接. The
 * card's own input joins the round; a small panel under the bar holds the
 * players-only talk, and an action box for a card whose input stays hidden.
 */

const TALK_FRESH_MS = 90_000;

type RoundView = {
  ui: StoryRoomUI;
  code: string;
  writing: boolean;
  failed: boolean;
  counting: boolean;
  active: boolean;
  status: string;
  fraction: number;
  showReady: boolean;
  freshTalk: StoryRoomUI["talk"][number] | null;
};

function failKey(code: string | null) {
  switch (code) {
    case "NO_CREDITS":
      return "storyRoom.round.failCredits" as const;
    case "spend-cap":
      return "storyRoom.round.failCap" as const;
    case "NO_API_KEY":
    case "no-profile":
      return "storyRoom.round.failKey" as const;
    case "CONCURRENT_LIMIT":
      return "storyRoom.round.failBusy" as const;
    case "MODEL_NOT_ALLOWED":
    case "MODEL_UNAVAILABLE":
    case "PROTECTED_WORLD":
      return "storyRoom.round.failModel" as const;
    default:
      return "storyRoom.round.failed" as const;
  }
}

/** The round as the bar shows it, ticking while it counts down. */
export function useRoundView(sessionId: string, enabled: boolean): RoundView | null {
  const { t } = useTranslation("common");
  const room = useRoomStore((s) => (s.room?.sessionId === sessionId && s.room.status === "open" ? s.room : null));
  const role = useRoomStore((s) => s.role);
  const snapshot = useRoomStore((s) => s.snapshot);
  const streaming = useChatStore((s) => s.isStreaming);
  const { data: auth } = useSession();
  const meId = auth?.user?.id ?? null;
  const snap = room && snapshot?.room.id === room.id ? snapshot : null;
  const ui = enabled && snap && meId ? storyRoomUI(snap, meId, role === "host") : null;
  const counting = !!ui && ui.round.status === "counting" && ui.round.dueAt != null && !streaming;
  const now = useNow(!!ui, counting ? 250 : 1000);
  if (!room || !ui) return null;

  const writing = streaming || ui.round.status === "writing";
  const failed = ui.round.status === "failed" && !writing;
  const typing = typingIds(ui.typingAt, now, meId).filter((id) => !ui.actedIds.includes(id));
  const active = writing || failed || !!ui.waiting || ui.actedIds.length > 0 || typing.length > 0;
  const latestTalk = ui.talk[ui.talk.length - 1] ?? null;
  const secondsLeft = counting ? Math.max(0, Math.ceil((ui.round.dueAt! - now) / 1000)) : 0;
  const acted = ui.actedIds.length ? t("storyRoom.round.acted", { count: ui.actedIds.length }) : "";
  const typingLine = typing.length
    ? `${typing.map((id) => ui.people[id]?.name ?? "?").slice(0, 2).join(", ")} ${t("storyRoom.round.typing")}`
    : "";
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const status: string = writing
    ? t("storyRoom.round.writing")
    : ui.waiting
      ? t("storyRoom.round.waiting", { have: ui.waiting.have, need: ui.waiting.need })
      : failed
        ? t(failKey(ui.round.failedCode))
        : ui.turnMode === "host" && !ui.isHost
          ? join(acted, t("storyRoom.round.hostSends"))
          : ui.round.status === "held"
            ? join(acted, t("storyRoom.round.held"))
            : counting
              ? join(t("storyRoom.round.countdown", { s: secondsLeft }), acted, typingLine)
              : ui.round.status === "counting" && ui.round.dueAt == null && ui.actedIds.length > 0
                ? join(t("storyRoom.round.untimed"), acted, typingLine)
                : join(acted, typingLine);
  return {
    ui,
    code: room.code,
    writing,
    failed,
    counting,
    active,
    status,
    fraction: counting && ui.round.windowMs > 0 ? Math.max(0, Math.min(1, (ui.round.dueAt! - now) / ui.round.windowMs)) : 0,
    showReady: ui.turnMode === "free" && !writing && !ui.waiting && ui.actedIds.length > 0 && ui.onlineCount > 1,
    freshTalk: latestTalk && now - Date.parse(latestTalk.createdAt) < TALK_FRESH_MS ? latestTalk : null,
  };
}

/** The round inside the room bar: status, 撤回, 我好了, 让 AI 接, and the countdown along the bar's foot. */
export function RoundInline({ sessionId, view }: { sessionId: string; view: RoundView }) {
  const { t } = useTranslation("common");
  const streaming = useChatStore((s) => s.isStreaming);
  const { ui, writing, failed } = view;
  const call = (p: Promise<unknown>) =>
    p.catch((err) => {
      if (err instanceof RoomApiError && (err.code === "already-claimed" || err.code === "not-found")) return;
      feedback.error(t("storyRoom.updateFailed"));
    });
  return (
    <>
      {view.active && (
        <span
          data-story-room-round=""
          className={cn("min-w-0 flex-1 truncate text-xs", writing ? "text-[#D8B26B]" : failed ? "text-amber-400" : "text-white/75")}
        >
          {view.status}
        </span>
      )}
      {!view.active && <span className="flex-1" />}
      {ui.mine && !writing && (
        <button
          type="button"
          onClick={() => void call(storyRoomApi.withdrawAction(view.code, ui.mine!.id))}
          className="hidden h-8 shrink-0 rounded-lg px-2 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white sm:block"
        >
          {t("storyRoom.round.withdraw")}
        </button>
      )}
      {view.showReady && (
        <button
          type="button"
          aria-pressed={ui.meReady}
          onClick={() => void call(storyRoomApi.setReady(view.code, !ui.meReady))}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold transition-colors",
            ui.meReady ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 text-white/85 hover:bg-white/15",
          )}
        >
          <Check className="h-3.5 w-3.5" />
          <span className="tabular-nums">{ui.doneCount}/{ui.onlineCount}</span>
        </button>
      )}
      {ui.raiseCap && (
        <button
          type="button"
          data-story-room-raise-cap=""
          onClick={() => void raiseRoomCapAndSend(sessionId, ui.raiseCap!.to)}
          className="h-8 shrink-0 rounded-lg bg-[#C9A25E] px-2.5 text-xs font-semibold text-[#121316] transition-opacity hover:opacity-90"
        >
          {ui.raiseCap.to == null
            ? t("storyRoom.round.raiseCapNone")
            : t("storyRoom.round.raiseCap", { amount: ui.raiseCap.to.toLocaleString() })}
        </button>
      )}
      {ui.canSendNow && !streaming && (
        <button
          type="button"
          onClick={() => void sendRoomNow(sessionId)}
          className="h-8 shrink-0 rounded-lg bg-[#C9A25E] px-2.5 text-xs font-semibold text-[#121316] transition-opacity hover:opacity-90"
        >
          {failed ? t("storyRoom.round.retry") : t("storyRoom.round.sendNow")}
        </button>
      )}
      {view.counting && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-[#C9A25E]/10" aria-hidden>
          <span className="block h-full bg-[#C9A25E] transition-[width] duration-200 ease-linear" style={{ width: `${view.fraction * 100}%` }} />
        </span>
      )}
    </>
  );
}

/** The bar's talk button: opens the panel; a dot while a fresh players-only line is unread. */
export function TalkButton({ view, open, onToggle }: { view: RoundView; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation("common");
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={t("storyRoom.round.talkTitle")}
      onClick={onToggle}
      data-story-room-talk-button=""
      className={cn(
        "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
        open ? "bg-sky-500/20 text-sky-200" : "text-white/70 hover:bg-white/10 hover:text-white",
      )}
    >
      <MessageCircle className="h-4 w-4" />
      {view.freshTalk && !open && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-sky-400" />}
    </button>
  );
}

/** Under the bar, while open: the players' talk and a line to the table (or, for members, an action). */
export function RoomQuickPanel({ sessionId, view, onClose }: { sessionId: string; view: RoundView; onClose: () => void }) {
  const { t } = useTranslation("common");
  const [draft, setDraft] = useState("");
  const [talk, setTalk] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { ui } = view;
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [ui.talk.length]);
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    routeSendToRoom(sessionId, text.slice(0, talk ? TALK_MAX_CHARS : ACTION_MAX_CHARS), { talk });
    setDraft("");
    inputRef.current?.focus();
  };
  const tab = "flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors";
  return (
    <div className="absolute inset-x-0 top-full z-30 px-3 pt-2 sm:px-4" data-story-room-panel="">
      <div className="mx-auto flex max-w-xl flex-col gap-2 rounded-2xl border border-white/10 bg-[#121316]/90 p-2.5 shadow-[0_18px_45px_rgba(0,0,0,0.55)] backdrop-blur-xl">
        {ui.talk.length > 0 && (
          <div ref={listRef} className="max-h-36 space-y-1 overflow-y-auto px-1 text-xs">
            {ui.talk.map((line) => (
              <p key={line.id} className="flex items-start gap-1.5 leading-relaxed text-white/85">
                <Portrait src={ui.people[line.userId]?.image} name={line.name} seed={line.userId} className="mt-0.5 h-4 w-4 shrink-0 rounded" monogramClassName="text-[8px]" />
                <span className="min-w-0 break-words">
                  <span className="text-sky-200/80">{line.userId === ui.meId ? t("storyRoom.you") : line.name}: </span>
                  {line.text}
                </span>
              </p>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button type="button" aria-pressed={talk} onClick={() => setTalk(true)} className={cn(tab, talk ? "bg-sky-500/20 text-sky-200" : "text-white/55 hover:text-white")}>
            <MessageCircle className="h-3 w-3" />
            {t("storyRoom.round.talk")}
          </button>
          {!ui.isHost && (
            <button type="button" aria-pressed={!talk} onClick={() => setTalk(false)} className={cn(tab, !talk ? "bg-[#C9A25E]/20 text-[#D8B26B]" : "text-white/55 hover:text-white")}>
              <PenLine className="h-3 w-3" />
              {t("storyRoom.round.act")}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label={t("storyRoom.back")} className="flex h-7 w-7 items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className={cn("flex h-10 items-center gap-1 rounded-xl border bg-white/[0.04] pl-3 pr-1", talk ? "border-sky-400/35" : "border-[#C9A25E]/35")}>
          <input
            ref={inputRef}
            value={draft}
            maxLength={talk ? TALK_MAX_CHARS : ACTION_MAX_CHARS}
            onChange={(e) => {
              setDraft(e.target.value);
              if (e.target.value.trim() && !talk) sendRoomTyping(sessionId);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                send();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
              }
            }}
            placeholder={talk ? t("storyRoom.round.talkPlaceholder") : t("storyRoom.round.composer")}
            className="min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-white/35 sm:text-sm"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim()}
            aria-label={t("storyRoom.round.send")}
            className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#121316] transition-opacity hover:opacity-90 disabled:opacity-35", talk ? "bg-sky-400" : "bg-[#C9A25E]")}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
