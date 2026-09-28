import { readFileSync } from "node:fs";
/** Shared by isolated tests, manual installation and the deployment preflight. */
export const SESSION_MEDIA_DDL = readFileSync(new URL("../../scripts/session-media.sql", import.meta.url), "utf8");
