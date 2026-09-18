import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { hasRecentPlayInteraction } from "./play-interaction";

type PlaytimeStatus = "idle" | "active" | "paused" | "flushing" | "stopped";
type PlaytimeEvent = "resume" | "tick" | "pause" | "stop";

interface PlaytimeState {
  status: PlaytimeStatus;
  isVisible: boolean;
  blockedByLease: boolean;
}

type PlaytimeAction =
  | { type: "ENTER_PLAY"; visible: boolean }
  | { type: "PAGE_VISIBLE" }
  | { type: "PAGE_HIDDEN" }
  | { type: "LEAVE_PLAY" }
  | { type: "PAGEHIDE" }
  | { type: "SYNC_OK"; event: PlaytimeEvent; active: boolean }
  | { type: "SYNC_FAIL"; event: PlaytimeEvent; leaseHeld?: boolean };

const PLAYTIME_TICK_MS = 15_000;
const PLAYTIME_RESUME_RETRY_MS = 5_000;

function reducePlaytimeState(state: PlaytimeState, action: PlaytimeAction): PlaytimeState {
  switch (action.type) {
    case "ENTER_PLAY":
      return {
        status: "paused",
        isVisible: action.visible,
        blockedByLease: false,
      };
    case "PAGE_VISIBLE":
      if (state.status === "stopped") return state;
      return {
        ...state,
        isVisible: true,
      };
    case "PAGE_HIDDEN":
      if (state.status === "stopped") return state;
      if (state.status === "active") {
        return {
          ...state,
          status: "flushing",
          isVisible: false,
          blockedByLease: false,
        };
      }
      return {
        ...state,
        status: "paused",
        isVisible: false,
      };
    case "LEAVE_PLAY":
    case "PAGEHIDE":
      if (state.status === "stopped") return state;
      return {
        ...state,
        status: "flushing",
        isVisible: false,
        blockedByLease: false,
      };
    case "SYNC_OK":
      if (action.event === "resume") {
        return {
          ...state,
          status: action.active ? "active" : "paused",
          blockedByLease: !action.active,
        };
      }
      if (action.event === "tick") {
        return action.active
          ? {
              ...state,
              status: "active",
              blockedByLease: false,
            }
          : {
              ...state,
              status: "paused",
              blockedByLease: true,
            };
      }
      if (action.event === "stop") {
        return {
          ...state,
          status: "stopped",
          blockedByLease: false,
        };
      }
      return {
        ...state,
        status: "paused",
        blockedByLease: false,
      };
    case "SYNC_FAIL":
      if (action.event === "stop") {
        return {
          ...state,
          status: "stopped",
          blockedByLease: false,
        };
      }
      return {
        ...state,
        status: "paused",
        blockedByLease: Boolean(action.leaseHeld),
      };
    default:
      return state;
  }
}

interface PlaytimeResponse {
  data?: {
    accepted?: boolean;
    active?: boolean;
    reason?: string;
  };
}

function isSameOrigin(url: string) {
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function usePlaytimeTracker(sessionId: string, enabled = true) {
  const apiBase = import.meta.env.VITE_API_URL || "";
  const endpoint = `${apiBase}/api/sessions/${sessionId}/playtime`;
  const leaseId = useMemo(() => crypto.randomUUID(), [sessionId]);
  const [state, dispatch] = useReducer(reducePlaytimeState, {
    status: "idle",
    isVisible: typeof document === "undefined" ? true : document.visibilityState === "visible",
    blockedByLease: false,
  });

  const mountedRef = useRef(false);
  const controlSequenceRef = useRef(0);
  const resumeContinuityRef = useRef(false);

  const postPlaytimeEvent = useCallback(
    async (event: PlaytimeEvent, options?: { beacon?: boolean; recoverElapsed?: boolean }): Promise<PlaytimeResponse | null> => {
      const payload = JSON.stringify({ event, leaseId, recentInput: hasRecentPlayInteraction(sessionId), recoverElapsed: options?.recoverElapsed });

      if (options?.beacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && isSameOrigin(endpoint)) {
        const sent = navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
        if (sent) return null;
      }

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          keepalive: options?.beacon ?? false,
          body: payload,
        });

        if (!response.ok) {
          return null;
        }

        return (await response.json().catch(() => null)) as PlaytimeResponse | null;
      } catch {
        return null;
      }
    },
    [endpoint, leaseId, sessionId]
  );

  const attemptResume = useCallback(
    async (sequence: number) => {
      const recoverElapsed = resumeContinuityRef.current;
      const response = await postPlaytimeEvent("resume", { recoverElapsed });
      if (!mountedRef.current || sequence !== controlSequenceRef.current) return;

      const active = Boolean(response?.data?.accepted && response.data.active);
      if (active) {
        resumeContinuityRef.current = true;
        dispatch({ type: "SYNC_OK", event: "resume", active: true });
        return;
      }

      dispatch({
        type: "SYNC_FAIL",
        event: "resume",
        leaseHeld: response?.data?.reason === "lease-held",
      });
    },
    [postPlaytimeEvent]
  );

  const syncPause = useCallback(
    async (sequence: number) => {
      const response = await postPlaytimeEvent("pause", { beacon: true });
      if (!mountedRef.current || sequence !== controlSequenceRef.current) return;

      if (response?.data?.accepted === false) {
        dispatch({
          type: "SYNC_FAIL",
          event: "pause",
          leaseHeld: response.data.reason === "lease-held",
        });
        return;
      }

      dispatch({ type: "SYNC_OK", event: "pause", active: false });
    },
    [postPlaytimeEvent]
  );

  const flushStop = useCallback(() => {
    void postPlaytimeEvent("stop", { beacon: true });
  }, [postPlaytimeEvent]);

  const sendTick = useCallback(async () => {
    const sequence = controlSequenceRef.current;
    const response = await postPlaytimeEvent("tick");
    if (!mountedRef.current || sequence !== controlSequenceRef.current) return;

    if (response?.data?.accepted === false || !response?.data?.active) {
      dispatch({
        type: "SYNC_FAIL",
        event: "tick",
        leaseHeld: response?.data?.reason === "lease-held",
      });
      return;
    }

    dispatch({ type: "SYNC_OK", event: "tick", active: true });
  }, [postPlaytimeEvent]);

  useEffect(() => {
    resumeContinuityRef.current = false;
    if (!enabled) {
      // Treat disabling the same as unmount — pause tracking
      mountedRef.current = false;
      controlSequenceRef.current += 1;
      dispatch({ type: "LEAVE_PLAY" });
      flushStop();
      return;
    }

    mountedRef.current = true;
    dispatch({
      type: "ENTER_PLAY",
      visible: typeof document === "undefined" ? true : document.visibilityState === "visible",
    });

    const handleVisibility = () => {
      resumeContinuityRef.current = false;
      if (document.visibilityState === "visible") {
        dispatch({ type: "PAGE_VISIBLE" });
        return;
      }

      const sequence = ++controlSequenceRef.current;
      dispatch({ type: "PAGE_HIDDEN" });
      void syncPause(sequence);
    };

    const handlePageHide = () => {
      resumeContinuityRef.current = false;
      controlSequenceRef.current += 1;
      dispatch({ type: "PAGEHIDE" });
      flushStop();
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      resumeContinuityRef.current = false;
      // Back/forward cache restores this hook without mounting it again.
      dispatch({ type: "ENTER_PLAY", visible: document.visibilityState === "visible" });
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      mountedRef.current = false;
      resumeContinuityRef.current = false;
      controlSequenceRef.current += 1;
      dispatch({ type: "LEAVE_PLAY" });
      flushStop();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [enabled, flushStop, syncPause]);

  useEffect(() => {
    if (!enabled || !state.isVisible || state.status !== "paused") return;

    const sequence = ++controlSequenceRef.current;
    let inFlight = false;

    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await attemptResume(sequence);
      } finally {
        inFlight = false;
      }
    };

    void run();
    const intervalId = window.setInterval(() => {
      void run();
    }, PLAYTIME_RESUME_RETRY_MS);

    return () => window.clearInterval(intervalId);
  }, [attemptResume, enabled, state.isVisible, state.status]);

  useEffect(() => {
    if (!enabled || !state.isVisible || state.status !== "active") return;

    let inFlight = false;
    const intervalId = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await sendTick();
      } finally {
        inFlight = false;
      }
    }, PLAYTIME_TICK_MS);

    return () => window.clearInterval(intervalId);
  }, [enabled, sendTick, state.isVisible, state.status]);

  return state;
}
