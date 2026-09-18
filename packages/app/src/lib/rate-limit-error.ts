import { feedback } from "./feedback";
import i18n from "./i18n";

const tr = (key: string, fallback: string, options?: Record<string, unknown>) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback, ...options });

/**
 * When `res` is a rate-limiter 429, show the localized "wait ~N min" toast and
 * return true so the caller skips its generic failure toast. The server sends
 * Retry-After in seconds; the body's error text ("Too many requests. Please
 * wait N seconds.") is the fallback when the header isn't exposed.
 */
export function handleRateLimitToast(res: Response, body?: unknown): boolean {
  const code = (body as { code?: string } | null | undefined)?.code;
  if (res.status !== 429 && code !== "RATE_LIMITED") return false;
  const headerSeconds = Number(res.headers.get("Retry-After"));
  const bodySeconds = Number(/\d+/.exec((body as { error?: string } | null | undefined)?.error ?? "")?.[0]);
  const seconds = headerSeconds > 0 ? headerSeconds : bodySeconds > 0 ? bodySeconds : 3600;
  feedback.error(
    tr("toasts:rateLimited", "Too many requests — wait about {{minutes}} min and try again.", {
      minutes: Math.max(1, Math.ceil(seconds / 60)),
    }),
  );
  return true;
}
