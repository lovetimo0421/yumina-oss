import { Hono } from "hono";
import { edition } from "./impl.js";

/**
 * GET /api/edition — the one thing the client needs to know which surfaces
 * exist. Public (mounted before the broad auth middleware) so a logged-out
 * browser can decide whether to show a login screen or auto-sign-in.
 */
export const editionRoutes = new Hono();

editionRoutes.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ data: edition.info() });
});
