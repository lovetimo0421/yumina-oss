// Pure helpers for the per-account login-abuse step-up. No env/redis imports,
// so they stay trivially unit-testable. The Redis-backed failure counter and
// the Turnstile verification live in turnstile.ts.

/** Recent failed logins on one account before a Turnstile token is required. */
export const LOGIN_STEPUP_THRESHOLD = 5;

/** Rolling window (seconds) the failure counter survives after the last failure. */
export const LOGIN_FAIL_TTL_S = 900; // 15 minutes

/**
 * The account identifier from an auth request body, lowercased + trimmed, or
 * "" when neither email nor username is present (or not a string). Keying the
 * abuse counter on this — the account being attacked — is what makes the
 * defense NAT-safe (shared-IP neighbours are never punished).
 */
export function extractLoginIdentifier(body: Record<string, unknown>): string {
  const raw = body.email ?? body.username;
  return typeof raw === "string" ? raw.toLowerCase().trim() : "";
}
