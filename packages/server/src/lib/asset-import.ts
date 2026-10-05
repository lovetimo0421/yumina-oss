import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { ASSET_IMPORT_DDL } from "../db/asset-import-ddl.js";
import { env } from "./env.js";
import { sessionMedia, sessionMediaLimit } from "./session-media.js";
import { copyObject, deleteObject, generateUploadUrl, getObjectBufferLimited, headObject, putObject } from "./s3.js";
import { createAssetImportService } from "./asset-import-service.js";
import { AssetImportError } from "./asset-archive.js";
import { admitCreativeUpload, creativeUploadPolicy } from "./creative-upload-policy.js";
import { ensureWallet } from "./credit-service.js";
import { resolveEffectivePlanWithEventEntitlements } from "./event-plan-entitlements.js";

export const assetImports = createAssetImportService({
  db,
  quota: { lockOwner: sessionMedia.lockOwner, usage: sessionMedia.usage, limit: sessionMediaLimit },
  uploadPolicy: {
    admit: async (tx, userId, operationId, bytes, storageLimit) => {
      const result = await admitCreativeUpload(tx, userId, "archive", operationId, bytes, storageLimit);
      if (result !== "admitted") throw new AssetImportError(result === "limit" ? "ARCHIVE_RATE_LIMIT" : "ARCHIVE_CONFLICT", result === "limit" ? 429 : 409);
    },
    priority: async userId => {
      const wallet = await ensureWallet(userId);
      const plan = await resolveEffectivePlanWithEventEntitlements(userId, wallet.plan);
      return creativeUploadPolicy(plan).priority;
    },
  },
  storage: {
    signUpload: (key, size) => generateUploadUrl(key, "application/octet-stream", { contentLength: size, expiresIn: 3600 }),
    head: headObject,
    copy: copyObject,
    read: getObjectBufferLimited,
    write: (key, bytes, mimeType) => putObject(key, bytes, mimeType, { signal: AbortSignal.timeout(30_000) }),
    remove: deleteObject,
  },
});

let installed = false;
let working = false;
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;

export function kickAssetImports() {
  if (working || stopped) return;
  working = true;
  void (async () => {
    if (!installed) {
      await db.transaction(async tx => {
        // Serializes the additive migration on a multi-replica deployment.
        if (env.DATABASE_URL) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('asset-import-schema'))`);
        for (const statement of ASSET_IMPORT_DDL.split(";").filter(s => s.trim())) await tx.execute(sql.raw(statement));
      });
      installed = true;
    }
    for (let count = 0; count < 4 && !stopped; count++) {
      if (!(await assetImports.processNext())) break;
    }
    await assetImports.sweep();
  })().catch(error => {
    console.error("[asset-import] worker tick failed", error instanceof Error ? error.message : "unknown");
  }).finally(() => { working = false; });
}

export function startAssetImportWorker() {
  if (timer) return;
  stopped = false;
  kickAssetImports();
  timer = setInterval(kickAssetImports, 10_000);
  timer.unref();
}

export function stopAssetImportWorker() {
  stopped = true;
  clearInterval(timer);
  timer = undefined;
}
