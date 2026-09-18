import { createFileRoute, redirect } from "@tanstack/react-router";
import { getLandingRoute } from "@/edition/routes";

export const Route = createFileRoute("/app/")({
  // /app's beforeLoad has already resolved the edition, so this reads it directly.
  beforeLoad: () => {
    throw redirect({ to: getLandingRoute() });
  },
});
