import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/lib/require-session";
import { lazyRouteComponent } from "@/lib/lazy-route-component";

const SettingsPage = lazyRouteComponent(
  () => import("@/features/settings/settings-page"),
  (m) => m.SettingsPage
);

export const Route = createFileRoute("/app/settings")({
  beforeLoad: async ({ location }) => {
    await requireSession(location);
  },
  component: () => (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <SettingsPage />
    </Suspense>
  ),
});
