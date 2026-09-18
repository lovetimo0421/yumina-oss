import { Hono } from "hono";

type Options = { timeoutMs?: number; cacheMs?: number; onDegraded?: (failed: string[]) => void };

/** Keep a timed-out probe in flight until its underlying operation settles.
 * Otherwise each caller can abandon one SQL query and start another. */
function sharedProbe(probe: () => PromiseLike<unknown>, timeoutMs: number, cacheMs: number) {
  let current: { response: Promise<boolean>; settled: boolean; expiresAt: number } | undefined;
  return () => {
    if (current && (!current.settled || Date.now() < current.expiresAt)) return current.response;
    const entry = { response: Promise.resolve(false), settled: false, expiresAt: Infinity };
    const underlying = Promise.resolve().then(probe);
    entry.response = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        entry.settled = true;
        entry.expiresAt = Date.now() + cacheMs;
        resolve(ok);
      };
      underlying.then(() => finish(true), () => finish(false));
    });
    current = entry;
    return entry.response;
  };
}

export function createHealthRoutes(probes: Record<string, () => PromiseLike<unknown>>, options: Options = {}) {
  const routes = new Hono();
  const names = Object.keys(probes);
  const checksByName = Object.fromEntries(names.map((name) => [name,
    sharedProbe(probes[name]!, options.timeoutMs ?? 5000, options.cacheMs ?? 1000),
  ]));
  let lastFailures = "";
  routes.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  // Independent liveness: no database, Redis, auth or external service calls.
  routes.get("/live", (c) => c.json({ status: "ok" }));
  routes.get("/", async (c) => {
    const results = await Promise.all(names.map((name) => checksByName[name]!()));
    const checks = Object.fromEntries(names.map((name, i) => [name, results[i] ? "ok" : "down"]));
    const failed = names.filter((name) => checks[name] === "down");
    const failureKey = failed.join(",");
    if (failureKey !== lastFailures) {
      lastFailures = failureKey;
      if (failed.length) {
        try { options.onDegraded?.(failed); } catch { /* health reporting is best effort */ }
      }
    }
    return c.json({ status: failed.length ? "degraded" : "ok", checks, timestamp: new Date().toISOString() }, failed.length ? 503 : 200);
  });
  return routes;
}
