import { useEffect, useMemo, useState } from "react";
import { useYumina } from "../sandbox-context";
import { makeChatT } from "./i18n";

interface SwipeControlsProps {
  message: {
    id: string;
    swipes?: Array<{ content: string }>;
    activeSwipeIndex?: number;
    model?: string | null;
  };
}

export function SwipeControls({ message }: SwipeControlsProps) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);

  const swipes = message.swipes ?? [];
  const currentIndex = message.activeSwipeIndex ?? 0;
  const totalSwipes = swipes.length;

  const isAtLastSwipe = currentIndex >= totalSwipes - 1;
  const canGenerateNew = isAtLastSwipe && !!message.model;

  // Local double-tap lock. `api.isStreaming` only flips after a postMessage
  // round-trip to the host, so a fast second tap on "generate new" would fire
  // regenerateMessage twice (= two generations, two credit charges) before the
  // guard engages. The lock is released when streaming actually starts, when
  // the swipe promise settles, or by the timeout fallback if the host rejected
  // the request without ever streaming.
  const [swipePending, setSwipePending] = useState(false);
  useEffect(() => {
    if (api.isStreaming) setSwipePending(false);
  }, [api.isStreaming]);

  // Keep hooks unconditional: variants/model can arrive after the first render
  // or disappear when a greeting changes, without remounting this component.
  if (totalSwipes <= 1 && !message.model) return null;

  const handleSwipe = async (direction: "left" | "right") => {
    if (api.isStreaming || swipePending) return;

    if (direction === "right" && isAtLastSwipe) {
      if (!message.model) return;
      // Generate a new swipe via regenerate (fire-and-forget to the host)
      setSwipePending(true);
      api.regenerateMessage(message.id);
      window.setTimeout(() => setSwipePending(false), 4000);
      return;
    }

    setSwipePending(true);
    try {
      await api.swipeMessage(message.id, direction);
    } catch {
      api.showToast(t("failedSwitchVariant"), "error");
    } finally {
      setSwipePending(false);
    }
  };

  return (
    <div className="flex items-center gap-1 rounded-full bg-muted/30 px-2 py-0.5">
      <button
        onClick={() => handleSwipe("left")}
        disabled={currentIndex <= 0 || api.isStreaming || swipePending}
        className="hover-surface play-action-btn flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/50 disabled:pointer-events-none disabled:opacity-20"
        title={t("previousResponse")}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>

      <span className="min-w-[32px] text-center text-xs text-muted-foreground/50">
        {totalSwipes > 0 ? `${currentIndex + 1}/${totalSwipes}` : "1/1"}
      </span>

      <button
        onClick={() => handleSwipe("right")}
        disabled={api.isStreaming || swipePending || (isAtLastSwipe && !message.model)}
        className={[
          "hover-surface play-action-btn flex h-7 w-7 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-20",
          canGenerateNew
            ? "text-primary/60 hover:text-primary"
            : "text-muted-foreground/50",
        ].join(" ")}
        title={
          isAtLastSwipe
            ? message.model
              ? t("generateNew")
              : t("lastResponse")
            : t("nextResponse")
        }
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}
