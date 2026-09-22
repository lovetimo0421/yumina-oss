import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { StoryReturnContext } from "@/lib/story-return";
import { consumeDiscoveryHandoff, discoveryAttribution, type DiscoveryAttribution } from "@/lib/discovery-attribution";

const apiBase = import.meta.env.VITE_API_URL || "";

export function useGuestSessionStart(ready: boolean, worldId: string, returnContext: StoryReturnContext) {
  const router = useRouter();
  // StrictMode reuses the same creation request; a failed attempt stays here for retry.
  const [startError, setStartError] = useState(false);
  const [startAttempt, setStartAttempt] = useState(0);
  const creation = useRef<{ worldId: string; attempt: number; request: Promise<string>; failed: boolean } | null>(null);
  const origin = useRef<{ worldId: string; attribution: DiscoveryAttribution | undefined } | null>(null);
  useEffect(() => {
    if (!ready) return;
    // Consume only when this exact preview target starts. Keep its immutable
    // original-card receipt across StrictMode replay and explicit retries.
    if (origin.current?.worldId !== worldId) {
      origin.current = { worldId, attribution: discoveryAttribution(consumeDiscoveryHandoff(worldId)) };
    }
    const attribution = origin.current.attribution;
    let cancelled = false;
    const sourceHref = router.state.location.href;
    setStartError(false);
    if (creation.current?.worldId !== worldId || (creation.current.failed && creation.current.attempt !== startAttempt)) {
      const pending = {
        worldId, attempt: startAttempt, failed: false,
        request: (async () => {
          const res = await fetch(apiBase + "/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ worldId, discoveryAttribution: attribution }),
          });
          if (!res.ok) throw new Error("Session creation failed");
          const { data } = await res.json();
          if (!data?.id) throw new Error("Session creation failed");
          return data.id as string;
        })(),
      };
      creation.current = pending;
      // A navigation failure may retry the resolved session ID. Only a failed
      // creation request authorizes another POST for this target.
      void pending.request.catch(() => { pending.failed = true; });
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

  return { startError, retryStart: () => {
    if (!ready || !startError) return;
    setStartError(false);
    setStartAttempt((attempt) => attempt + 1);
  } };
}
