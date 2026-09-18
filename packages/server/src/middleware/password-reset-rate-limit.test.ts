import test from "node:test";
import assert from "node:assert/strict";
import {
  checkPasswordResetRateLimit,
  PWRESET_MAX_PER_EMAIL,
} from "./rate-limit.js";

// ─── Password-reset limiter (2026-08-24 auth hardening) ────────────────────
// Added after a user report that forgot-password could be hammered. The cap is
// PER-EMAIL and deliberately NOT per-IP: it stops inbox bombing of one victim
// while leaving VPN / carrier-NAT users (who share an exit IP) alone. Runs on
// the in-memory fallback here (REDIS_URL unset), exactly as when Redis is down.

test("per-email cap: allows PWRESET_MAX_PER_EMAIL, then blocks the same address", async () => {
  const email = `victim-${Date.now()}@example.com`;
  for (let i = 0; i < PWRESET_MAX_PER_EMAIL; i++) {
    assert.equal(
      await checkPasswordResetRateLimit(email),
      null,
      `email request ${i + 1} of ${PWRESET_MAX_PER_EMAIL} should pass`,
    );
  }
  const blocked = await checkPasswordResetRateLimit(email);
  assert.ok(blocked, "request over the per-email cap should be blocked");
  assert.equal(blocked.code, "RATE_LIMITED");
  assert.ok(
    blocked.retryAfter > 0 && blocked.retryAfter <= 15 * 60,
    `retryAfter ${blocked?.retryAfter} out of the 15-min window`,
  );
});

test("per-email cap is keyed on the normalized address (case/whitespace-insensitive)", async () => {
  const base = `Mixed-${Date.now()}@Example.com`;
  for (let i = 0; i < PWRESET_MAX_PER_EMAIL; i++) {
    assert.equal(await checkPasswordResetRateLimit(base), null);
  }
  // Same address, different casing + surrounding spaces → must hit the same bucket.
  const blocked = await checkPasswordResetRateLimit(`  ${base.toUpperCase()}  `);
  assert.ok(blocked, "case/whitespace variant of the same email must share the limit");
});

test("distinct victims do not interfere below the cap", async () => {
  const stamp = Date.now();
  assert.equal(await checkPasswordResetRateLimit(`a-${stamp}@example.com`), null);
  assert.equal(await checkPasswordResetRateLimit(`b-${stamp}@example.com`), null);
});

test("empty email is a no-op (Better Auth handles the malformed request)", async () => {
  // Many distinct-but-empty calls must never be throttled here — this path is
  // reached only when the body has no usable email; the limiter must not block
  // it on some shared bucket. Better Auth returns the 400.
  for (let i = 0; i < PWRESET_MAX_PER_EMAIL + 5; i++) {
    assert.equal(await checkPasswordResetRateLimit(""), null, "empty email must never be rate-limited");
  }
});
