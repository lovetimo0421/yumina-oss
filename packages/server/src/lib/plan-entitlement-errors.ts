interface DatabaseErrorLike {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
}

/**
 * During a rolling deployment, code that writes admin entitlements can briefly
 * run before the post-listen schema self-heal relaxes the old event-only check.
 * Recognize only that exact schema-lag failure so the admin route can use its
 * legacy wallet fallback; every other database error must still surface.
 */
export function isPlanEntitlementSourceConstraintError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as DatabaseErrorLike;
    const mentionsConstraint =
      candidate.constraint === "plan_entitlements_source_check"
      || (typeof candidate.message === "string"
        && candidate.message.includes("plan_entitlements_source_check"));
    if (candidate.code === "23514" && mentionsConstraint) return true;
    current = candidate.cause;
  }
  return false;
}
