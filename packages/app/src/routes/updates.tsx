import { createFileRoute, redirect } from "@tanstack/react-router";

// yumina.io/updates is the address people share; the page lives in the app shell.
export const Route = createFileRoute("/updates")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/app/updates", hash: location.hash || undefined, replace: true });
  },
});
