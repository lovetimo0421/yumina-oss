import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell";
import { isCreatorHost } from "@/lib/creator-hub-url";
import { ensureLocalSession } from "@/edition/local-sign-in";
import { getEditionInfo } from "@/edition/edition";
import { HOSTED_ROUTES } from "@/edition/routes";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    // Resolves the edition and, in single-user mode, mints the local account
    // session before any authenticated child route loads. No-op when hosted.
    await ensureLocalSession();
    if (typeof window !== "undefined" && getEditionInfo().features.hub && isCreatorHost()) {
      throw redirect({ to: HOSTED_ROUTES.creator });
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
