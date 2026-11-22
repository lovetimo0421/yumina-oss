import { useCallback, useEffect, useRef, useState } from "react";
import { storyRoomApi } from "./api";
import { applyRoomEvent, applyStreamEvent, EMPTY_ROOM_VIEW, IDLE_REPLY, type LiveReply, type RoomView } from "./room-logic";

const ROOM_EVENTS = [
  "snapshot",
  "member",
  "action",
  "action-removed",
  "ready",
  "turn-start",
  "turn-done",
  "room",
  "round",
  "talk",
  "typing",
  "state",
  "closed",
  "kicked",
] as const;

/**
 * One room's SSE channel, folded into a RoomView. The server's first event is
 * a full snapshot, so a reconnect needs nothing else to catch up. Reconnects
 * back off exponentially like the friend-invite channel; a closed or kicked
 * room stops reconnecting.
 */
export function useRoomChannel(
  code: string | null,
  opts?: {
    onTurnDone?: (done: { messageId: string | null; error: boolean }) => void;
    /** Every frame after it is folded in, `stream` included when tracked. */
    onEvent?: (name: string, data: unknown) => void;
    trackStream?: boolean;
  },
): { view: RoomView; live: LiveReply; connected: boolean; clearLive: () => void } {
  const [view, setView] = useState<RoomView>(EMPTY_ROOM_VIEW);
  const [live, setLive] = useState<LiveReply>(IDLE_REPLY);
  const [connected, setConnected] = useState(false);
  const onTurnDoneRef = useRef(opts?.onTurnDone);
  onTurnDoneRef.current = opts?.onTurnDone;
  const onEventRef = useRef(opts?.onEvent);
  onEventRef.current = opts?.onEvent;
  const trackStream = opts?.trackStream ?? false;

  useEffect(() => {
    setView(EMPTY_ROOM_VIEW);
    setLive(IDLE_REPLY);
    if (!code) return;
    let source: EventSource | null = null;
    let stopped = false;
    let retries = 0;
    let timer: number | undefined;

    const connect = () => {
      if (stopped) return;
      source = new EventSource(storyRoomApi.eventsUrl(code), { withCredentials: true });
      source.onopen = () => {
        retries = 0;
        setConnected(true);
      };
      for (const name of ROOM_EVENTS) {
        source.addEventListener(name, (event) => {
          let data: unknown = null;
          try {
            data = JSON.parse((event as MessageEvent).data || "null");
          } catch {
            /* a malformed frame changes nothing */
          }
          setView((prev) => applyRoomEvent(prev, name, data));
          onEventRef.current?.(name, data);
          if (name === "turn-done") {
            const d = (data ?? {}) as { messageId?: unknown; error?: unknown };
            onTurnDoneRef.current?.({ messageId: typeof d.messageId === "string" ? d.messageId : null, error: d.error === true });
          }
          if (name === "closed" || name === "kicked") {
            stopped = true;
            source?.close();
            setConnected(false);
          }
        });
      }
      if (trackStream) {
        source.addEventListener("stream", (event) => {
          try {
            const payload = JSON.parse((event as MessageEvent).data);
            setLive((prev) => applyStreamEvent(prev, payload));
            onEventRef.current?.("stream", payload);
          } catch {
            /* ignore */
          }
        });
      }
      source.onerror = () => {
        source?.close();
        source = null;
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(30_000, 1_000 * 2 ** retries);
        retries += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      source?.close();
    };
  }, [code, trackStream]);

  // The caller clears the live reply once the saved one has loaded, so the
  // text never blinks out between turn-done and the history refetch.
  const clearLive = useCallback(() => setLive(IDLE_REPLY), []);
  return { view, live, connected, clearLive };
}
