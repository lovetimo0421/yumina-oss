import { db } from "../db/index.js";
import { createSessionMediaService } from "./session-media-service.js";
import { generateUploadUrl, generatePrivateReadUrl, getObjectBufferLimited, putObject, deleteObject, storageKind } from "./s3.js";
import { PLANS } from "./plan-config.js";
import { ensureWallet } from "./credit-service.js";
import { resolveEffectivePlanWithEventEntitlements } from "./event-plan-entitlements.js";
export const sessionMedia = createSessionMediaService(db, {
    signUpload: (key, mime, size, seconds) => generateUploadUrl(key, mime, { contentLength: size, expiresIn: seconds }),
    signRead: generatePrivateReadUrl,
    read: getObjectBufferLimited,
    write: (key, bytes) => putObject(key, bytes, "image/webp", { signal: AbortSignal.timeout(30000) }),
    remove: deleteObject,
});
export async function sessionMediaLimit(userId: string) {
    const wallet = await ensureWallet(userId);
    const plan = await resolveEffectivePlanWithEventEntitlements(userId, wallet.plan);
    return PLANS[plan].storageCap;
}
/** Available to every save with private object storage. The emergency switch
 * pauses new writes only; existing images remain readable. No world allowlist. */
export function sessionMediaUploadsEnabled(_userId: string, _worldId: string) {
    return storageKind() === 's3' && process.env.SESSION_MEDIA_UPLOADS_ENABLED !== 'false';
}
let sweeping = false;
export function startSessionMediaCleanup() {
    const timer = setInterval(() => {
        if (sweeping)
            return;
        sweeping = true;
        sessionMedia.sweep().catch(() => console.error('[session-media] cleanup failed')).finally(() => { sweeping = false; });
    }, 60000);
    timer.unref();
    return timer;
}
