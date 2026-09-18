import { createFileRoute, redirect } from "@tanstack/react-router";
import { isCreatorHost } from "@/lib/creator-hub-url";
import { ensureEditionLoaded } from "@/edition/edition";
import { getLandingRoute } from "@/edition/routes";
import { RootIndexComponent } from "@/edition/slots";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    // Resolve the edition first: the landing route differs (Discover vs
    // Library), and the creator host only exists in the hosted edition.
    const edition = await ensureEditionLoaded();
    if (typeof window !== "undefined" && edition.features.hub && isCreatorHost()) {
      return;
    }
    // search: true forwards the query string through the redirect. Ad-campaign
    // attribution depends on it: paid traffic lands on `/?utm_*&rdt_cid=...`,
    // and without forwarding, the params are stripped before analytics reads
    // them — every ad visitor shows up as "direct" (found 2026-07-30 after two
    // days of Reddit spend attributed to nobody).
    throw redirect({ to: getLandingRoute(), search: true });
  },
  // Only reached on the creator host (hosted edition); the local seam renders null.
  component: RootIndexComponent,
});
