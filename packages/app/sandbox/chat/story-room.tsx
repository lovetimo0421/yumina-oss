import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, Hand, MessageCircle } from "lucide-react";
import { useYumina } from "../sandbox-context";
import { postToParentWindow, wrapMessage, type StoryRoomChannelData } from "../protocol";
import { makeChatT } from "./i18n";
import type { SandboxMessage } from "./types";

/**
 * A story room inside the chat: the round strip above the composer (who has
 * acted or is writing, the server's countdown, 我好了 / 让 AI 接), the
 * players-only talk feed, the composer's 只给队友看 / AI 先别接 chips, a
 * member's composer, and the players' bubbles a merged round is drawn as.
 * Room state arrives on the UI channel (`api.storyRoom`); the buttons are
 * platform calls to the parent, which talks to the server. The server sends
 * every round to the AI, so no browser has to stay open for it.
 */

type Person = StoryRoomChannelData["people"][string];
type ChatT = ReturnType<typeof makeChatT>;

/** How a line joins the room: players-only talk, or an action that keeps the AI waiting. */
export type RoomMode = { talk: boolean; hold: boolean };
export const ROOM_MODE_OFF: RoomMode = { talk: false, hold: false };

const TYPING_TTL_MS = 5_000;
const TYPING_EVERY_MS = 2_500;
const TALK_FRESH_MS = 90_000;

function callParent(method: string, args: unknown[] = []) {
  postToParentWindow(wrapMessage({ type: "api-call" as const, callId: `${method}-${Date.now()}`, method, args }));
}

/** A line from this composer joins the room (the parent posts it to the server). */
export function postToRoom(text: string, mode: RoomMode) {
  callParent("storyRoom.post", [text, { talk: mode.talk, hold: !mode.talk && mode.hold }]);
}

// ── Does this screen have the platform composer? ──────────────────────
// A card with its own full screen has no round strip of ours: the parent
// then shows the round (and a composer for members) above the card. The
// platform composer reports itself; the screen says once it has settled.
let composersMounted = 0;
let composerReport: number | undefined;
function reportComposers() {
  window.clearTimeout(composerReport);
  composerReport = window.setTimeout(() => callParent("storyRoom.composer", [composersMounted > 0]), 400);
}

/** The platform composer is on screen while this is mounted. */
export function useRoomComposerPresence() {
  useEffect(() => {
    composersMounted += 1;
    reportComposers();
    return () => {
      composersMounted -= 1;
      reportComposers();
    };
  }, []);
}

/** The card's screen has drawn: tell the parent whether it carries our composer. */
export function reportRoomComposerAfterBoot(delayMs = 1500): () => void {
  const id = window.setTimeout(reportComposers, delayMs);
  return () => window.clearTimeout(id);
}

let lastTypingAt = 0;
/** "正在写" for the others, at most every few seconds. */
export function signalRoomTyping(mode: RoomMode) {
  if (mode.talk) return;
  const now = Date.now();
  if (now - lastTypingAt < TYPING_EVERY_MS) return;
  lastTypingAt = now;
  callParent("storyRoom.typing");
}

function Face({ person, name, ring, size = 24, dim }: { person?: Person | null; name: string; ring?: boolean; size?: number; dim?: boolean }) {
  const style = { width: size, height: size };
  const cls = `shrink-0 rounded-full object-cover ${ring ? "ring-2 ring-primary" : "border border-border"} ${dim ? "opacity-60" : ""}`;
  if (person?.image) return <img src={person.image} alt="" draggable={false} style={style} className={cls} />;
  return (
    <span style={style} className={`${cls} flex items-center justify-center bg-muted text-[10px] font-semibold text-foreground/80`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function useTick(active: boolean, everyMs = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [active, everyMs]);
  return now;
}

function typingNow(room: StoryRoomChannelData, now: number): string[] {
  return Object.entries(room.typingAt ?? {})
    .filter(([id, at]) => id !== room.meId && now - at < TYPING_TTL_MS && !room.actedIds.includes(id))
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}

function failText(t: ChatT, code: string | null): string {
  switch (code) {
    case "NO_CREDITS":
      return t("roomFailCredits");
    case "spend-cap":
      return t("roomFailCap");
    case "NO_API_KEY":
    case "no-profile":
      return t("roomFailKey");
    case "CONCURRENT_LIMIT":
      return t("roomFailBusy");
    case "MODEL_NOT_ALLOWED":
    case "MODEL_UNAVAILABLE":
    case "PROTECTED_WORLD":
      return t("roomFailModel");
    default:
      return t("roomFailed");
  }
}

/** The round being gathered. Renders nothing while the room is quiet. */
export function RoundStrip({ room }: { room: StoryRoomChannelData }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const { status } = room.round;
  const writing = api.isStreaming || status === "writing";
  const counting = status === "counting" && room.round.dueAt != null && !writing;
  const hasTyping = Object.keys(room.typingAt ?? {}).length > 0;
  const now = useTick(counting || hasTyping, counting ? 250 : 1000);
  const typing = typingNow(room, now);
  const failed = status === "failed" && !writing;
  if (!writing && !room.waiting && !failed && room.actedIds.length === 0 && typing.length === 0) return null;

  const acted = room.actedIds.length > 0 ? t("roomActed", { count: room.actedIds.length }) : "";
  const secondsLeft = counting ? Math.max(0, Math.ceil((room.round.dueAt! - now) / 1000)) : 0;
  const fraction = counting && room.round.windowMs > 0 ? Math.max(0, Math.min(1, (room.round.dueAt! - now) / room.round.windowMs)) : 0;
  const typingLine = typing.length
    ? `${typing.map((id) => room.people[id]?.name ?? "?").slice(0, 2).join(", ")}${typing.length > 2 ? "…" : ""} ${t("roomTyping")}`
    : "";
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const text = writing
    ? t("roomWriting")
    : room.waiting
      ? t("roomWaiting", { have: room.waiting.have, need: room.waiting.need })
      : failed
        ? failText(t, room.round.failedCode)
        : room.turnMode === "host" && !room.isHost
          ? join(acted, t("roomHostSends"))
          : status === "held"
            ? join(acted, t("roomHeld"))
            : counting
              ? join(acted, t("roomCountdown", { s: secondsLeft }), typingLine)
              : status === "counting" && room.round.dueAt == null && room.actedIds.length > 0
                ? join(t("roomUntimed"), acted, typingLine)
                : join(acted, typingLine);
  const showReady = room.turnMode === "free" && !writing && !room.waiting && room.actedIds.length > 0 && room.onlineCount > 1;
  const canSendNow = room.canSendNow && !api.isStreaming;

  return (
    <div className="play-room-strip relative mb-2 overflow-hidden rounded-xl border border-border/60 bg-background/70 backdrop-blur" data-story-room-strip="">
      <div className="flex min-h-10 items-center gap-2 px-2.5 py-1.5">
        <span className="flex shrink-0 -space-x-1.5">
          {room.actedIds.slice(0, 5).map((id) => {
            const person = room.people[id];
            return <Face key={id} person={person} name={person?.name ?? "?"} size={22} dim={room.heldIds.includes(id)} />;
          })}
          {typing.slice(0, 3).map((id) => {
            const person = room.people[id];
            return (
              <span key={`typing-${id}`} className="relative">
                <Face person={person} name={person?.name ?? "?"} size={22} dim />
                <span className="absolute -bottom-1 -right-1 rounded-full bg-background px-0.5 text-[9px] font-bold leading-none text-primary">…</span>
              </span>
            );
          })}
        </span>
        <span className={`min-w-0 flex-1 truncate text-xs ${writing ? "text-primary" : failed ? "text-amber-400" : "text-muted-foreground"}`}>
          {text}
        </span>
        {room.mine && !writing && (
          <button
            type="button"
            onClick={() => callParent("storyRoom.withdraw", [room.mine!.id])}
            className="h-8 shrink-0 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("roomWithdraw")}
          </button>
        )}
        {showReady && (
          <button
            type="button"
            aria-pressed={room.meReady}
            onClick={() => callParent("storyRoom.ready", [!room.meReady])}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
              room.meReady ? "bg-emerald-500/15 text-emerald-400" : "bg-accent text-foreground/80 hover:text-foreground"
            }`}
          >
            <Check className="h-3.5 w-3.5" />
            {t("roomReady")}
            <span className="tabular-nums opacity-70">{room.doneCount}/{room.onlineCount}</span>
          </button>
        )}
        {room.raiseCap && (
          <button
            type="button"
            onClick={() => callParent("storyRoom.raiseCap", [room.raiseCap!.to])}
            className="h-8 shrink-0 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            {room.raiseCap.to == null ? t("roomRaiseCapNone") : t("roomRaiseCap", { amount: room.raiseCap.to.toLocaleString() })}
          </button>
        )}
        {canSendNow && (
          <button
            type="button"
            onClick={() => callParent("storyRoom.sendNow")}
            className="h-8 shrink-0 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            {failed ? t("roomRetry") : t("roomSendNow")}
          </button>
        )}
      </div>
      {counting && (
        <div className="absolute inset-x-0 bottom-0 h-[2px] bg-primary/10" aria-hidden>
          <div className="h-full bg-primary transition-[width] duration-200 ease-linear" style={{ width: `${fraction * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/** 只给队友看 lines: the newest one while it is fresh, the rest one tap away. */
export function TalkFeed({ room }: { room: StoryRoomChannelData }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const lines = room.talk ?? [];
  const latest = lines[lines.length - 1] ?? null;
  const now = useTick(!!latest && !open, 10_000);
  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, lines.length]);
  if (!latest) return null;
  const fresh = now - Date.parse(latest.createdAt) < TALK_FRESH_MS;
  const nameOf = (line: { userId: string; name: string }) => (line.userId === room.meId ? t("roomYou") : line.name);

  return (
    <div className="play-room-talk mb-1.5 rounded-xl border border-sky-400/20 bg-sky-500/[0.06] text-xs" data-story-room-talk="">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-8 w-full items-center gap-1.5 px-2.5 py-1 text-left"
      >
        <MessageCircle className="h-3.5 w-3.5 shrink-0 text-sky-300/80" />
        <span className="shrink-0 font-semibold text-sky-200/90">{t("roomTalkTitle")}</span>
        {!open && fresh ? (
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            <span className="text-sky-200/70">{nameOf(latest)}: </span>
            {latest.text}
          </span>
        ) : (
          <span className="flex-1 tabular-nums text-muted-foreground">{lines.length}</span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div ref={listRef} className="max-h-40 space-y-1 overflow-y-auto px-2.5 pb-2">
          {lines.map((line) => (
            <p key={line.id} className="whitespace-pre-wrap break-words leading-relaxed text-foreground/85">
              <span className="text-sky-200/70">{nameOf(line)}: </span>
              {line.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** 只给队友看 / AI 先别接: how the next line joins the room. */
export function RoomModeChips({ mode, onChange }: { mode: RoomMode; onChange: (mode: RoomMode) => void }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const chip = "flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium transition-colors";
  return (
    <div className="play-room-modes mb-1.5 flex items-center gap-1.5" data-story-room-modes="">
      <button
        type="button"
        aria-pressed={mode.talk}
        onClick={() => onChange({ talk: !mode.talk, hold: mode.hold })}
        className={`${chip} ${mode.talk ? "border-sky-400/50 bg-sky-500/15 text-sky-200" : "border-border/60 text-muted-foreground hover:text-foreground"}`}
      >
        <MessageCircle className="h-3 w-3" />
        {t("roomTalk")}
      </button>
      <button
        type="button"
        aria-pressed={mode.hold && !mode.talk}
        disabled={mode.talk}
        onClick={() => onChange({ talk: false, hold: !mode.hold })}
        className={`${chip} disabled:opacity-35 ${mode.hold && !mode.talk ? "border-primary/50 bg-primary/15 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground"}`}
      >
        <Hand className="h-3 w-3" />
        {t("roomHold")}
      </button>
    </div>
  );
}

/** A member's composer: their line joins the round; the server sends the round. */
export function RoomMemberComposer({ room }: { room: StoryRoomChannelData }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<RoomMode>(ROOM_MODE_OFF);
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    postToRoom(text.slice(0, mode.talk ? 1000 : 4000), mode);
    setDraft("");
    ref.current?.focus();
  };
  return (
    <div className="play-composer-shell shrink-0">
      <div className="play-composer-inner w-full min-w-0">
        <TalkFeed room={room} />
        <RoundStrip room={room} />
        <RoomModeChips mode={mode} onChange={setMode} />
        <div className={`play-composer-card glass relative flex items-end gap-2 rounded-2xl p-2 ${mode.talk ? "ring-1 ring-sky-400/40" : ""}`}>
          <textarea
            ref={ref}
            value={draft}
            rows={1}
            maxLength={mode.talk ? 1000 : 4000}
            onChange={(e) => {
              setDraft(e.target.value);
              if (e.target.value.trim()) signalRoomTyping(mode);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={mode.talk ? t("roomTalkPlaceholder") : t("roomComposer")}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/50 [field-sizing:content]"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim()}
            aria-label={t("roomSend")}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-35 ${mode.talk ? "bg-sky-500" : "bg-primary"}`}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** A merged round as one bubble per player: face, name and role. Mine sit on the right. */
export function RoomTurnBubbles({ contributions }: { contributions: NonNullable<SandboxMessage["contributions"]> }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const room = api.storyRoom;
  const meId = room?.meId ?? api.currentUser?.id ?? null;
  return (
    <div className="play-room-turn flex flex-col gap-2.5" data-room-turn="">
      {contributions.map((c, i) => {
        const person = room?.people[c.userId] ?? null;
        const mine = c.userId === meId;
        const roleName = c.roleName ?? person?.roleName ?? null;
        return (
          <div key={i} className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : ""}`}>
            <Face person={person} name={c.name} size={28} />
            <div className={`flex min-w-0 max-w-[82%] flex-col ${mine ? "items-end" : "items-start"}`}>
              <span className="mb-0.5 px-1 text-[11px] text-muted-foreground">
                {mine ? t("roomYou") : c.name}
                {roleName && <span className="text-primary/80"> · {roleName}</span>}
              </span>
              <div
                className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed text-foreground ${
                  mine ? "rounded-br-md border border-primary/25 bg-primary/12" : "rounded-bl-md border border-border/60 bg-muted/40"
                }`}
              >
                {c.text}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
