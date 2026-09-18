import { PostHog } from "posthog-node";
import { env } from "./env.js";
import { runtimeIdentity } from "./runtime-identity.js";

export const posthog = env.POSTHOG_API_KEY
  ? new PostHog(env.POSTHOG_API_KEY, { host: env.POSTHOG_HOST })
  : ({
      capture() {},
      captureException() {},
      identify() {},
      async flush() {},
      async shutdown() {},
    } as unknown as PostHog);

/**
 * Capture a server-side error into PostHog error tracking. Safe to call from
 * any failure path — never throws and never awaits, so it can't make a bad
 * situation worse. Events are batched by posthog-node; crash paths that exit
 * the process must still await posthog.shutdown() to flush the batch.
 */
export function captureServerError(
  scope: string,
  error: unknown,
  properties?: Record<string, unknown>,
): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    posthog.captureException(err, "server", { ...runtimeIdentity, scope, ...properties });
  } catch {
    /* telemetry must never break the caller */
  }
}
