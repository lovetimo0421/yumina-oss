import { createFileRoute, redirect } from "@tanstack/react-router";
import { ensureEditionLoaded } from "@/edition/edition";
import { getLandingRoute } from "@/edition/routes";
import { RootIndexComponent } from "@/edition/slots";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    // Resolve the edition first. Hosted: the home address IS Discover (and the
    // creator host's dashboard), rendered by the RootIndexComponent slot.
    // Local edition (no hub): forward to the library, keeping the query string.
    const edition = await ensureEditionLoaded();
    if (!edition.features.hub) {
      throw redirect({ to: getLandingRoute(), search: true });
    }
  },
  component: RootIndexComponent,
});
