import { createFileRoute, redirect } from "@tanstack/react-router";
import { ensureEditionLoaded } from "@/edition/edition";
import { ForgotPasswordPage } from "@/features/auth/forgot-password-page";

export const Route = createFileRoute("/forgot-password")({
    beforeLoad: async () => {
      const edition = await ensureEditionLoaded();
      if (edition.auth.mode === "single-user") throw redirect({ to: "/app/library" });
    },
    component: ForgotPasswordPage,
});
