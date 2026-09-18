import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { StoryReturnContext } from "@/lib/story-return";

const apiBase = import.meta.env.VITE_API_URL || "";

export function useGuestSessionStart(ready: boolean, worldId: string, returnContext: StoryReturnContext) {
  const router = useRouter();
  // StrictMode reuses the same creation request; a failed attempt stays here for retry.
  const [startError, setStartError] = useState(false);
  const [startAttempt, setStartAttempt] = useState(0);
  const creation = useRef<{ key: string; request: Promise<string> } | null>(null);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const sourceHref = router.state.location.href;
    const key = worldId + ":" + startAttempt;
    setStartError(false);
    if (creation.current?.key !== key) {
      creation.current = {
        key,
        request: (async () => {
          const res = await fetch(apiBase + "/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ worldId }),
          });
          if (!res.ok) throw new Error("Session creation failed");
          const { data } = await res.json();
          if (!data?.id) throw new Error("Session creation failed");
          return data.id as string;
        })(),
      };
    }
    void creation.current.request.then((sessionId) => {
      if (cancelled || router.state.location.href !== sourceHref) return;
      return router.navigate({
        to: "/app/chat/$sessionId",
        params: { sessionId },
        search: { moderationGroupKey: undefined, ...returnContext },
      });
    }).catch(() => {
      if (!cancelled && router.state.location.href === sourceHref) setStartError(true);
    });
    return () => { cancelled = true; };
  }, [ready, returnContext, worldId, router, startAttempt]);

  return { startError, retryStart: () => setStartAttempt((attempt) => attempt + 1) };
}
