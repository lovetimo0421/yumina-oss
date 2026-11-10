import { createFileRoute, redirect } from "@tanstack/react-router";
import { isOAuthResumeReturnTo, parseSafeAuthReturnTo } from "@/lib/auth-return";
import { getSessionSafe } from "@/lib/auth-client";
import { ensureEditionLoaded } from "@/edition/edition";
import { getLandingRoute } from "@/edition/routes";
import { RegisterPage } from "@/features/auth/register-page";

export const Route = createFileRoute("/register")({
  validateSearch: (search): { returnTo?: string } => ({
    returnTo: parseSafeAuthReturnTo(search.returnTo),
  }),
  beforeLoad: async ({ search }) => {
    // Single-user mode has no accounts to register.
    const edition = await ensureEditionLoaded();
    if (edition.auth.mode === "single-user") throw redirect({ to: "/app/library" });
    const session = await getSessionSafe();
    if (session.data) {
      // Already signed in mid-way through an outside app's sign-in: carry on to its consent page.
      if (search.returnTo && isOAuthResumeReturnTo(search.returnTo)) {
        window.location.replace(search.returnTo);
        return;
      }
      throw redirect({ to: getLandingRoute() });
    }
  },
  component: RegisterPage,
});
