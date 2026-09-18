import { Suspense } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionSafe } from "@/lib/auth-client";
import { lazyRouteComponent } from "@/lib/lazy-route-component";

const SettingsPage = lazyRouteComponent(
  () => import("@/features/settings/settings-page"),
  (m) => m.SettingsPage
);

export const Route = createFileRoute("/app/settings")({
  beforeLoad: async () => {
    const session = await getSessionSafe();
    if (!session.data) throw redirect({ to: "/login" });
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
