import { existsSync, readFileSync } from "node:fs";
/** Shared by isolated tests, manual installation and the deployment preflight. */
const bundled = new URL("./migrations/session-media.sql", import.meta.url);
export const SESSION_MEDIA_DDL = readFileSync(existsSync(bundled) ? bundled : new URL("../../scripts/session-media.sql", import.meta.url), "utf8");
