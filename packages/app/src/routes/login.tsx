import { createFileRoute, redirect } from "@tanstack/react-router";
import { ensureEditionLoaded } from "@/edition/edition";
import { LoginPage } from "@/features/auth/login-page";
import { parseSafeAuthReturnTo } from "@/lib/auth-return";

export const Route = createFileRoute("/login")({
  // Single-user mode auto-signs the local account in; there is no login page.
  beforeLoad: async () => {
    const edition = await ensureEditionLoaded();
    if (edition.auth.mode === "single-user") throw redirect({ to: "/app/library" });
  },
  validateSearch: (search): {
    returnTo?: string;
    accountDeleted?: "1";
  } => ({
    returnTo: parseSafeAuthReturnTo(search.returnTo),
    accountDeleted: search.accountDeleted === "1" ? "1" : undefined,
  }),
  component: LoginPage,
});
