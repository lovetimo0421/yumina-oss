// Self-destructing service worker.
//
// The previous version (yumina-shell-v1) cached the app shell + hashed assets.
// After a deploy it served a STALE shell to clients returning from the
// background — on iOS especially — pointing at chunk hashes the new build had
// already deleted. That produced "Importing a module script failed" loops and a
// black screen that only a tab-close cleared (investigation 2026-05-29; PostHog
// session 019e74cf-ece0-7609-bdcd-8932da610524 confirmed it).
//
// We no longer register a service worker (see main.tsx). This file remains ONLY
// so that browsers which still have the old SW registered fetch it on their
// next visit, then clear its caches and unregister — recovering those clients.
// It intercepts nothing (no fetch handler), so all requests go straight to the
// network/CDN and self-heal like before the SW existed.
//
// Once production SW count reaches zero, this file can be deleted.

self.addEventListener("install", () => {
  // Activate immediately, replacing the old caching SW.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 1. Delete every cache the old SW created.
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));

      // 2. Unregister so no SW controls these clients anymore.
      await self.registration.unregister();

      // 3. Reload open tabs so they re-fetch fresh from the network with no SW
      //    in the way. This recovers any tab currently stuck on the black
      //    screen. main.tsx no longer registers a SW, so the reloaded page
      //    installs nothing new — no loop.
      const clients = await self.clients.matchAll({ type: "window" });
      await Promise.all(clients.map((client) => client.navigate(client.url).catch(() => {})));
    })(),
  );
});
