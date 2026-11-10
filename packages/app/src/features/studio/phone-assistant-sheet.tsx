import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowUp, ChevronDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStudioStore } from "@/stores/studio";
import { AI_PRESENCE_EVENT, type AiPresence } from "./lib/agent-job";

export type SheetState = "peek" | "open";

/** The drawer collapsed: one bar, like a maps app's search box. */
export const SHEET_PEEK_H = 60;

/**
 * The creation assistant on a phone: a drawer over the foot of the board.
 *
 * Collapsed it is one bar — what you would type into, or, while the
 * assistant works, what it is changing — so the board keeps the screen.
 * A tap opens the conversation with the cursor already in the box, over the
 * whole screen under the header — opened, it is the assistant's page, the
 * way the 助手 tab was (a player, 10/21: a drawer stopping at three quarters
 * read as a page that would not come all the way up). A drag on the handle
 * opens or shuts it. A run starting drops it back to the bar,
 * so the board above shows the change happening (the block glows there and
 * the board goes to it); a run ending while collapsed leaves a dot on the
 * bar: there is a reply to read.
 */
export function PhoneAssistantSheet({ state, onState, hidden, children }: {
  state: SheetState;
  onState: (next: SheetState) => void;
  /** Kept mounted (the conversation and its stream live in it), not shown. */
  hidden?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation("editor");
  const working = useStudioStore((s) => s.isAgentWorking || s.isChatStreaming);
  const [doing, setDoing] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; start: number; moved: boolean } | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);

  // What the assistant is touching, in the words the board's glow uses.
  useEffect(() => {
    const onPresence = (e: Event) => setDoing((e as CustomEvent<AiPresence | null>).detail?.label ?? null);
    window.addEventListener(AI_PRESENCE_EVENT, onPresence);
    return () => window.removeEventListener(AI_PRESENCE_EVENT, onPresence);
  }, []);

  const wasWorking = useRef(working);
  useEffect(() => {
    if (working && !wasWorking.current) onState("peek");
    if (!working && wasWorking.current && state === "peek") setUnread(true);
    if (!working) setDoing(null);
    wasWorking.current = working;
  }, [working, state, onState]);
  useEffect(() => { if (state === "open") setUnread(false); }, [state]);

  const openH = () => sheetRef.current?.parentElement?.clientHeight ?? 700;

  /** Open on the box, keyboard up: synchronously, inside the tap, or a
   *  phone will not raise the keyboard for it. */
  const openToType = useCallback(() => {
    flushSync(() => onState("open"));
    sheetRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [onState]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { y: e.clientY, start: sheetRef.current?.clientHeight ?? SHEET_PEEK_H, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (Math.abs(dy) > 6) d.moved = true;
    if (d.moved) setDragH(Math.max(SHEET_PEEK_H, Math.min(openH(), d.start + dy)));
  }, []);
  const onPointerUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) { onState(state === "open" ? "peek" : "open"); setDragH(null); return; }
    const h = sheetRef.current?.clientHeight ?? SHEET_PEEK_H;
    onState(h > (SHEET_PEEK_H + openH()) / 2 ? "open" : "peek");
    setDragH(null);
  }, [onState, state]);

  const collapsed = state === "peek" && dragH === null;
  const height = dragH ?? (state === "open" ? `${openH()}px` : `calc(${SHEET_PEEK_H}px + env(safe-area-inset-bottom))`);

  return (
    <div
      ref={sheetRef}
      data-assistant-sheet={collapsed ? "peek" : "open"}
      data-onboarding="assistant"
      className={cn(
        "absolute inset-x-0 bottom-0 z-20 flex flex-col overflow-hidden rounded-t-2xl border-t border-white/10 bg-background shadow-[0_-12px_40px_rgba(0,0,0,0.45)]",
        dragH === null && "transition-[height] duration-200 ease-out",
        hidden && "invisible",
      )}
      style={{ height }}
      aria-hidden={hidden || undefined}
    >
      <div
        className={cn("flex shrink-0 touch-none cursor-grab select-none items-center justify-center", collapsed ? "h-3.5" : "h-8")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="button"
        aria-expanded={state === "open"}
        aria-label={t(state === "open" ? "studio.mobile.sheetCollapse" : "studio.mobile.sheetExpand")}
      >
        <span className="h-1 w-9 rounded-full bg-white/25" />
      </div>
      {/* Open over the whole board, the way back to it is said once more
          than the handle says it. */}
      {state === "open" && dragH === null && (
        <button
          type="button"
          data-assistant-sheet-close=""
          onClick={() => onState("peek")}
          aria-label={t("studio.mobile.sheetCollapse")}
          title={t("studio.mobile.sheetCollapse")}
          className="absolute right-1.5 top-0.5 z-10 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
      {collapsed && (
        <button
          type="button"
          data-assistant-bar=""
          onClick={openToType}
          className={cn(
            "mx-2.5 mb-[calc(env(safe-area-inset-bottom)+0.5rem)] flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-left text-[13px]",
            working ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-muted/50 text-muted-foreground",
          )}
        >
          {working && <Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse" />}
          <span className="min-w-0 flex-1 truncate">
            {working
              ? (doing ? t("studio.mobile.sheetDoing", { what: doing }) : t("studio.mobile.sheetWorking"))
              : unread ? t("studio.mobile.sheetReply") : t("studio.aiChat.placeholderDefault")}
          </span>
          {unread && !working && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
          {!working && <ArrowUp className="h-4 w-4 shrink-0 opacity-60" />}
        </button>
      )}
      {/* The conversation stays mounted (its stream lives here), out of
          sight while the drawer is the bar. */}
      <div className={cn("min-h-0 flex-1", collapsed && "hidden")}>{children}</div>
    </div>
  );
}
