import { createRootRoute, Outlet } from "@tanstack/react-router";
import { GlobalConfirmDialog } from "@/components/ui/global-confirm-dialog";

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <GlobalConfirmDialog />
    </>
  ),
});
