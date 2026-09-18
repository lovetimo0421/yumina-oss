import { Suspense } from "react";
import { createFileRoute, type SearchSchemaInput } from "@tanstack/react-router";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import { RouteFallback } from "@/components/route-fallback";
import { parseSafeInternalReturnUrl, parseStoryReturnKey } from "@/lib/story-return-url";

const LibraryPage = lazyRouteComponent(
  () => import("@/features/library/library-page"),
  (m) => m.LibraryPage
);

export const Route = createFileRoute("/app/library")({
  validateSearch: (search: {
    worldId?: unknown;
    view?: unknown;
    assetId?: unknown;
    returnTo?: unknown;
    returnKey?: unknown;
  } & SearchSchemaInput) => ({
    worldId: (search.worldId as string) || undefined,
    view: (search.view as string) || undefined,
    assetId: (search.assetId as string) || undefined,
    returnTo: parseSafeInternalReturnUrl(search.returnTo),
    returnKey: parseStoryReturnKey(search.returnKey),
  }),
  component: () => (
    <Suspense fallback={<RouteFallback />}>
      <LibraryPage />
    </Suspense>
  ),
});
