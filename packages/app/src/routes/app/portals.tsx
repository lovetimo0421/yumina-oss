import { createFileRoute, redirect } from "@tanstack/react-router";
import { getProfileRoute } from "@/edition/routes";

export const Route = createFileRoute("/app/portals")({
  beforeLoad: () => {
    throw redirect({ to: getProfileRoute() });
  },
});
