import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireSession } from "@/lib/require-session";

export const Route = createFileRoute("/app/profile")({
  beforeLoad: async ({ location }) => {
    await requireSession(location);
  },
  component: () => <Outlet />,
});
