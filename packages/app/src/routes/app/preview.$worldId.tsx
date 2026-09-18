import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import { parseSafeInternalReturnUrl, parseStoryReturnKey } from "@/lib/story-return-url";

const WorldPreview = lazyRouteComponent(
  () => import("@/features/chat/world-preview"),
  (m) => m.WorldPreview
);

function PreviewRoute() {
  const { worldId } = Route.useParams();
  const returnContext = Route.useSearch();
  return (
    <Suspense fallback={<Loading />}>
      <WorldPreview worldId={worldId} returnContext={returnContext} />
    </Suspense>
  );
}

export const Route = createFileRoute("/app/preview/$worldId")({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string; returnKey?: string } => ({
    returnTo: parseSafeInternalReturnUrl(search.returnTo),
    returnKey: parseStoryReturnKey(search.returnKey),
  }),
  component: PreviewRoute,
});

function Loading() {
    return (
        <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
        </div>
    );
}
