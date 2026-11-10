import { createAssetImportRoutes } from "./asset-import-router.js";
import { authMiddleware } from "../middleware/auth.js";
import { storageKind } from "../lib/s3.js";
import { assetImports, kickAssetImports } from "../lib/asset-import.js";

export const assetImportRoutes = createAssetImportRoutes({
  service: assetImports, auth: authMiddleware, available: () => storageKind() === "s3", kick: kickAssetImports,
});
