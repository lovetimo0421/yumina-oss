/**
 * Is PostHog configured for this build?
 *
 * The open-source edition ships without a project token. posthog-js does not
 * throw when used before `init()`, but it logs "You must initialize PostHog
 * before calling capture" on every call, so telemetry helpers check this first
 * and stay silent. `?.` because `tsx --test` has no `import.meta.env`.
 */
export function isAnalyticsEnabled(): boolean {
  const env = import.meta.env;
  // Outside Vite (the node test runner) there is no env at all; keep the
  // helpers live there so tests can still assert on captured events.
  if (!env) return true;
  return !!env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
}
