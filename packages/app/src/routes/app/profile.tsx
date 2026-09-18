import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSessionSafe } from "@/lib/auth-client";

export const Route = createFileRoute("/app/profile")({
  beforeLoad: async () => {
    const session = await getSessionSafe();
    if (!session.data) throw redirect({ to: "/login" });
  },
  component: () => <Outlet />,
});
