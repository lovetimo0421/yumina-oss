import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { importWithChunkRecovery } from "@/lib/stale-chunk-reload";
import { parseSafeInternalReturnUrl, parseStoryReturnKey } from "@/lib/story-return-url";
import type { StoryReturnContext } from "@/lib/story-return";

const ChatView = lazy(() =>
  importWithChunkRecovery(() => import("@/features/chat/chat-view")).then((m) => ({ default: m.ChatView }))
);

const CHAT_PATH_RE = /^\/app\/chat\/([^/]+)/;

/**
 * Keeps the last-visited ChatView mounted across route navigations so the
 * sandbox iframe (and its loaded assets) survive round-trips to library/hub.
 *
 * Rendered inside AppShell's <main>. Uses `display:none` when inactive.
 */
export function PersistentChat() {
  const location = useLocation();
  const { pathname } = location;
  const currentSessionId = CHAT_PATH_RE.exec(pathname)?.[1] ?? null;
  const currentModerationGroupKey = currentSessionId
    ? new URLSearchParams(location.searchStr).get("moderationGroupKey") ?? undefined
    : undefined;
  const currentReturnTo = currentSessionId
    ? parseSafeInternalReturnUrl(new URLSearchParams(location.searchStr).get("returnTo"))
    : undefined;
  const currentReturnKey = currentSessionId
    ? parseStoryReturnKey(new URLSearchParams(location.searchStr).get("returnKey"))
    : undefined;

  const [persistedSessionId, setPersistedSessionId] = useState<string | null>(
    () => CHAT_PATH_RE.exec(window.location.pathname)?.[1] ?? null
  );
  const [persistedModerationGroupKey, setPersistedModerationGroupKey] = useState<string | undefined>(() => {
    if (!CHAT_PATH_RE.exec(window.location.pathname)) return undefined;
    return new URLSearchParams(window.location.search).get("moderationGroupKey") ?? undefined;
  });
  const [persistedReturnContext, setPersistedReturnContext] = useState<StoryReturnContext>(() => {
    if (!CHAT_PATH_RE.exec(window.location.pathname)) return {};
    const search = new URLSearchParams(window.location.search);
    return {
      returnTo: parseSafeInternalReturnUrl(search.get("returnTo")),
      returnKey: parseStoryReturnKey(search.get("returnKey")),
    };
  });

  useEffect(() => {
    if (currentSessionId) {
      setPersistedSessionId(currentSessionId);
      setPersistedModerationGroupKey(currentModerationGroupKey);
      setPersistedReturnContext({ returnTo: currentReturnTo, returnKey: currentReturnKey });
    }
  }, [currentModerationGroupKey, currentReturnKey, currentReturnTo, currentSessionId]);

  const sessionIdToRender = currentSessionId ?? persistedSessionId;
  const isActive = currentSessionId != null && currentSessionId === sessionIdToRender;
  const moderationGroupKey = currentSessionId ? currentModerationGroupKey : persistedModerationGroupKey;
  const returnContext: StoryReturnContext = currentSessionId
    ? { returnTo: currentReturnTo, returnKey: currentReturnKey }
    : persistedReturnContext;

  // Unmount hidden ChatView after 60s to free memory, but keep it alive while
  // generation is active so route changes do not interrupt the SSE stream.
  useEffect(() => {
    if (isActive || !persistedSessionId) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const checkAndMaybeUnmount = () => {
      timeout = setTimeout(async () => {
        const { useChatStore } = await import("@/stores/chat");
        if (cancelled) return;

        if (useChatStore.getState().isStreaming) {
          checkAndMaybeUnmount();
          return;
        }

        setPersistedSessionId(null);
      }, 60_000);
    };

    checkAndMaybeUnmount();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [isActive, persistedSessionId]);

  if (!sessionIdToRender) return null;

  return (
    <div
      className={
        isActive
          ? "flex h-full w-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          : "hidden"
      }
    >
      <Suspense fallback={<LoadingSpinner />}>
        <ChatView
          sessionId={sessionIdToRender}
          isActive={isActive}
          moderationGroupKey={moderationGroupKey}
          returnContext={returnContext}
        />
      </Suspense>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
    </div>
  );
}
