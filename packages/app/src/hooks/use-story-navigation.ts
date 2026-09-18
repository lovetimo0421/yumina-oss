import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { captureStoryReturnContext, type StoryReturnContext } from "@/lib/story-return";
import { getPlayNavigationSearch } from "@/lib/story-return-url";

/** Capture an entry page once, then carry its return target through session changes. */
export function useStoryNavigation() {
  const router = useRouter();
  return useCallback((sessionId: string, returnContext?: StoryReturnContext) => {
    const location = router.state.location;
    const search = getPlayNavigationSearch(location.pathname, location.search, returnContext, captureStoryReturnContext);
    return router.navigate({ to: "/app/chat/$sessionId", params: { sessionId }, search });
  }, [router]);
}
