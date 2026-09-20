import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import { validateExtensionsSearch } from "@/features/extensions/extension-search";

const ExtensionsPage = lazyRouteComponent(
  () => import("@/features/extensions/extensions-page"),
  (m) => m.ExtensionsPage,
);

export const Route = createFileRoute("/app/extensions")({
  validateSearch: validateExtensionsSearch,
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
