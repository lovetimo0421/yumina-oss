import { AssetImportDialog } from "@/features/library/asset-import-dialog";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { GlobalConfirmDialog } from "@/components/ui/global-confirm-dialog";
import { AssetUploadHost } from "@/features/library/folder-upload-dialog";
import { DocumentTitleSync } from "@/components/document-title-sync";
import { NotFoundPage } from "@/components/not-found-page";

// GlobalConfirmDialog lives here because `confirmAction()` is a promise that
// only settles when this component renders the request — and for as long as
// nothing mounted it, every confirmAction button in the app (interface
// export, code-view confirms, API keys, playthrough deletion) silently did
// nothing forever. The root route is the one place no shell refactor removes.
export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <GlobalConfirmDialog />
      <AssetUploadHost />
      <AssetImportDialog />
      <DocumentTitleSync />
    </>
  ),
  notFoundComponent: () => <NotFoundPage standalone />,
});
