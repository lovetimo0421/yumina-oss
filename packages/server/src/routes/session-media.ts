import { db } from "../db/index.js";
import { authMiddleware } from "../middleware/auth.js";
import { sessionMedia, sessionMediaLimit, sessionMediaUploadsEnabled } from "../lib/session-media.js";
import { isS3Configured } from "../lib/s3.js";
import { createSessionMediaRoutes } from "./session-media-router.js";
export const sessionMediaRoutes = createSessionMediaRoutes({
    db, authMiddleware, sessionMedia, sessionMediaLimit, sessionMediaUploadsEnabled, isS3Configured,
});
