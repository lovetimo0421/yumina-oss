import { createFileRoute } from "@tanstack/react-router";
import { UpdatesPage } from "@/features/updates/updates-page";

/** The update log. Public: logged-out visitors read it too; entries come from the repo's changelog/ via /api/changelog. */
export const Route = createFileRoute("/app/updates")({
  component: UpdatesPage,
});
