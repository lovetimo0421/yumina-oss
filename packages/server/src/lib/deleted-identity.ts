import { createHmac } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { deletedAccountTombstones, user } from "../db/schema.js";
import { env } from "./env.js";
import { isDeletedIdentityRegistrationBlocked } from "./deleted-identity-policy.js";

function deletedIdentitySecrets(): string[] {
  const configured = env.DELETED_IDENTITY_HMAC_SECRETS
    .split(",")
    .map((secret) => secret.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [env.BETTER_AUTH_SECRET];
}

function hashWithSecret(email: string, secret: string): string {
  const normalized = email.trim().normalize("NFKC").toLowerCase();
  return createHmac("sha256", secret)
    .update(`deleted-account:v1:${normalized}`)
    .digest("hex");
}

export function hashDeletedIdentity(email: string): string {
  return hashWithSecret(email, deletedIdentitySecrets()[0]!);
}

export function hashDeletedIdentityCandidates(email: string): string[] {
  return deletedIdentitySecrets().map((secret) => hashWithSecret(email, secret));
}

export async function getDeletedIdentity(email: string) {
  try {
    const records = await db
      .select()
      .from(deletedAccountTombstones)
      .where(inArray(deletedAccountTombstones.identityHash, hashDeletedIdentityCandidates(email)));
    if (records.length === 0) return null;

    // During HMAC rotation both the old and new hash can temporarily exist.
    // Merge conservatively so an arbitrary row order can never drop a ban or
    // allow a reward that an older key had already blocked.
    const first = records[0]!;
    const latestDeletionAt = records
      .map((record) => record.updatedAt)
      .sort((left, right) => left.getTime() - right.getTime())
      .at(-1)!;
    return {
      ...first,
      wasBanned: records.some((record) => record.wasBanned),
      blockWelcomeRewards: records.some((record) => record.blockWelcomeRewards),
      blockInviteRedemption: records.some((record) => record.blockInviteRedemption),
      lastCheckinDay: records
        .map((record) => record.lastCheckinDay)
        .filter((day): day is string => !!day)
        .sort()
        .at(-1) ?? null,
      rewardBlockedUntil: records
        .map((record) => record.rewardBlockedUntil)
        .filter((date): date is Date => !!date)
        .sort((left, right) => left.getTime() - right.getTime())
        .at(-1) ?? null,
      latestDeletionAt,
    };
  } catch (error) {
    // Testing creates the table in the delayed schema self-heal. Do not break
    // unrelated signups during that short post-deploy window.
    if ((error as { code?: string } | null)?.code === "42P01") return null;
    throw error;
  }
}

async function removeRejectedSignupUser(userId: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const removed = await db
        .delete(user)
        .where(eq(user.id, userId))
        .returning();
      if (removed.length > 0) return;

      const [remaining] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      if (!remaining) return;
      lastError = new Error(`Rejected signup user ${userId} still exists`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to remove rejected signup user ${userId}`);
}

/**
 * Close the same-email race between an uncommitted banned-account deletion
 * tombstone and a signup INSERT. A newly visible ban is reapplied and the
 * inserted user is removed before Better Auth can leave a usable account
 * behind. Ordinary deleted identities may register again immediately.
 */
export async function rejectBannedDeletedIdentityAfterCreate(userId: string, email: string) {
  let deletedIdentity: Awaited<ReturnType<typeof getDeletedIdentity>>;
  try {
    deletedIdentity = await getDeletedIdentity(email);
  } catch (lookupError) {
    try {
      await removeRejectedSignupUser(userId);
    } catch (cleanupError) {
      throw new AggregateError(
        [lookupError, cleanupError],
        `Deleted-identity lookup and signup compensation both failed for ${userId}`,
      );
    }
    throw lookupError;
  }
  if (!isDeletedIdentityRegistrationBlocked(deletedIdentity)) return deletedIdentity;

  await removeRejectedSignupUser(userId);
  return deletedIdentity;
}
