import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../lib/types.js";
import { AssetImportError } from "../lib/asset-archive.js";
import type { createAssetImportService } from "../lib/asset-import-service.js";

type Service = ReturnType<typeof createAssetImportService>;
const reserveSchema = z.object({
  id: z.string().uuid(), filename: z.string().min(1).max(200),
  size: z.number().int().positive(), folderId: z.string().min(1).max(200).nullable(),
});
const startSchema = z.object({ preserveFolders: z.boolean(), conflict: z.enum(["rename", "skip"]) });

export function createAssetImportRoutes(deps: {
  service: Service; auth: MiddlewareHandler<AppEnv>; available: () => boolean; kick: () => void;
}) {
  const routes = new Hono<AppEnv>();
  routes.use("/*", deps.auth);
  routes.use("/*", bodyLimit({ maxSize: 16 * 1024 }));
  routes.use("/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (!deps.available()) return c.json({ error: "ARCHIVE_UNAVAILABLE", code: "ARCHIVE_UNAVAILABLE" }, 503);
    await next();
  });
  routes.onError((error, c) => {
    if (error instanceof AssetImportError) return c.json({ error: error.code, code: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "ARCHIVE_INVALID_REQUEST", code: "ARCHIVE_INVALID_REQUEST" }, 400);
    console.error("[asset-import] request failed", error instanceof Error ? error.name : "unknown");
    return c.json({ error: "ARCHIVE_STORAGE_ERROR", code: "ARCHIVE_STORAGE_ERROR" }, 503);
  });
  routes.get("/", async c => c.json({ data: await deps.service.list(c.get("user").id) }));
  routes.post("/", async c => {
    const input = reserveSchema.parse(await c.req.json());
    return c.json({ data: await deps.service.reserve(c.get("user").id, input) }, 201);
  });
  routes.get("/:id", async c => c.json({ data: await deps.service.detail(c.get("user").id, c.req.param("id")) }));
  routes.post("/:id/uploaded", async c => {
    const job = await deps.service.uploaded(c.get("user").id, c.req.param("id"));
    deps.kick();
    return c.json({ data: job });
  });
  routes.post("/:id/start", async c => {
    const input = startSchema.parse(await c.req.json());
    const job = await deps.service.start(c.get("user").id, c.req.param("id"), input);
    deps.kick();
    return c.json({ data: job });
  });
  routes.post("/:id/retry", async c => {
    const job = await deps.service.retry(c.get("user").id, c.req.param("id"));
    deps.kick();
    return c.json({ data: job });
  });
  routes.post("/:id/dismiss", async c => {
    await deps.service.dismiss(c.get("user").id, c.req.param("id"));
    return c.json({ data: { ok: true } });
  });
  return routes;
}
