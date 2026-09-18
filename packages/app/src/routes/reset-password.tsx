import { createFileRoute, redirect } from "@tanstack/react-router";
import { ensureEditionLoaded } from "@/edition/edition";
import { ResetPasswordPage } from "@/features/auth/reset-password-page";

type ResetPasswordSearch = {
    token?: string;
    error?: string;
};

export const Route = createFileRoute("/reset-password")({
    beforeLoad: async () => {
      const edition = await ensureEditionLoaded();
      if (edition.auth.mode === "single-user") throw redirect({ to: "/app/library" });
    },
    component: ResetPasswordPage,
    validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => ({
        token: typeof search.token === "string" ? search.token : undefined,
        error: typeof search.error === "string" ? search.error : undefined,
    }),
});
