import { and, eq, or } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { follows } from "../db/schema.js";

export type ProfileVisibility = "public" | "followers" | "private";

export interface ProfilePrivacy {
  profileVisibility: ProfileVisibility;
  allowDMs: boolean;
  showPlayHistory: boolean;
  showStats: boolean;
  showFollowLists: boolean;
  showFavorites: boolean;
}

export interface ProfileFollowDirections {
  ownerFollowsViewer: boolean;
  viewerFollowsOwner: boolean;
}

export function readProfilePrivacy(preferences: unknown): ProfilePrivacy {
  const prefs = (preferences as Record<string, unknown> | null | undefined) ?? {};
  const privacy = (prefs.privacy as Record<string, unknown> | undefined) ?? {};
  const rawVisibility = privacy.profileVisibility;
  const profileVisibility =
    rawVisibility === "followers" || rawVisibility === "private" || rawVisibility === "public"
      ? rawVisibility
      : privacy.isPrivateAccount === true
        ? "followers"
        : "public";

  return {
    profileVisibility,
    allowDMs: privacy.allowDMs !== false,
    showPlayHistory: privacy.showPlayHistory !== false && privacy.showRecentPlay !== false,
    showStats: privacy.showStats !== false,
    showFollowLists: privacy.showFollowLists !== false && privacy.showStats !== false,
    showFavorites: privacy.showFavorites !== false,
  };
}

export function canViewRestrictedProfile(input: {
  profileVisibility: ProfileVisibility;
  isSelf: boolean;
  ownerFollowsViewer: boolean;
}): boolean {
  if (input.isSelf || input.profileVisibility === "public") return true;
  if (input.profileVisibility === "private") return false;
  return input.ownerFollowsViewer;
}

export function profileFollowDirections(profileOwnerUserId: string, viewerUserId: string) {
  return {
    ownerFollowsViewer: {
      followerId: profileOwnerUserId,
      followingId: viewerUserId,
    },
    viewerFollowsOwner: {
      followerId: viewerUserId,
      followingId: profileOwnerUserId,
    },
  } as const;
}

/**
 * Resolve both directed follow edges used on a public profile. The privacy
 * grant is deliberately owner -> viewer; viewer -> owner only drives the
 * Follow/Following button state.
 */
export async function readProfileFollowDirections(
  database: DrizzleDB,
  profileOwnerUserId: string,
  viewerUserId: string | null | undefined,
): Promise<ProfileFollowDirections> {
  if (!viewerUserId || viewerUserId === profileOwnerUserId) {
    return { ownerFollowsViewer: false, viewerFollowsOwner: false };
  }

  const directions = profileFollowDirections(profileOwnerUserId, viewerUserId);
  const rows = await database
    .select({ followerId: follows.followerId, followingId: follows.followingId })
    .from(follows)
    .where(
      or(
        and(
          eq(follows.followerId, directions.ownerFollowsViewer.followerId),
          eq(follows.followingId, directions.ownerFollowsViewer.followingId),
        ),
        and(
          eq(follows.followerId, directions.viewerFollowsOwner.followerId),
          eq(follows.followingId, directions.viewerFollowsOwner.followingId),
        ),
      ),
    );

  return {
    ownerFollowsViewer: rows.some(
      (row) =>
        row.followerId === directions.ownerFollowsViewer.followerId &&
        row.followingId === directions.ownerFollowsViewer.followingId,
    ),
    viewerFollowsOwner: rows.some(
      (row) =>
        row.followerId === directions.viewerFollowsOwner.followerId &&
        row.followingId === directions.viewerFollowsOwner.followingId,
    ),
  };
}
