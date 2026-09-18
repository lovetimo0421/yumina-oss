import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@/lib/lazy-route-component";

const ExtensionsPage = lazyRouteComponent(
  () => import("@/features/extensions/extensions-page"),
  (m) => m.ExtensionsPage,
);

export const Route = createFileRoute("/app/extensions")({
  validateSearch: (search: Record<string, unknown>): { tab?: "discover" | "manage" } => ({
    tab: search.tab === "manage" ? "manage" : search.tab === "discover" ? "discover" : undefined,
  }),
  component: () => (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <ExtensionsPage />
    </Suspense>
  ),
});
