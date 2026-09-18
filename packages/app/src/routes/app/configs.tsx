import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/configs")({
  beforeLoad: () => {
    throw redirect({ to: "/app/settings" });
  },
  component: () => null,
});
