import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionSafe } from "@/lib/auth-client";
import { useChatStore } from "@/stores/chat";
import { parseSafeInternalReturnUrl, parseStoryReturnKey } from "@/lib/story-return-url";

// ChatView is rendered persistently by PersistentChat in AppShell
// so the sandbox iframe survives navigation. This route only handles auth.
export const Route = createFileRoute("/app/chat/$sessionId")({
  validateSearch: (search: Record<string, unknown>): {
    moderationGroupKey?: string;
    returnTo?: string;
    returnKey?: string;
  } => ({
    moderationGroupKey: typeof search.moderationGroupKey === "string" ? search.moderationGroupKey : undefined,
    returnTo: parseSafeInternalReturnUrl(search.returnTo),
    returnKey: parseStoryReturnKey(search.returnKey),
  }),
  beforeLoad: async () => {
    const session = await getSessionSafe();
    if (!session.data) throw redirect({ to: "/login" });
  },
  loader: async ({ params }) => {
    const store = useChatStore.getState();
    if (store.session?.id === params.sessionId) return;
    await store.loadSession(params.sessionId);
  },
  component: () => null,
});
