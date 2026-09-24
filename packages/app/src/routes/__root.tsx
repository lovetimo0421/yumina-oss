import { createRootRoute, Outlet } from "@tanstack/react-router";
import { GlobalConfirmDialog } from "@/components/ui/global-confirm-dialog";
import { AssetUploadHost } from "@/features/library/folder-upload-dialog";

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <GlobalConfirmDialog />
      <AssetUploadHost />
    </>
  ),
});
