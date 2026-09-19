import { createFileRoute } from "@tanstack/react-router";
import { PopupDonePage } from "@/features/auth/popup-done-page";

/** OAuth popup landing page (see lib/popup-auth.ts). Lives
 *  outside /app on purpose: no shell, it only reports back and closes. */
export const Route = createFileRoute("/auth/popup-done")({
  validateSearch: (search): { error?: string } => ({
    error: typeof search.error === "string" && search.error ? search.error.slice(0, 80) : undefined,
  }),
  component: PopupDonePage,
});
