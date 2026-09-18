import { useSession } from "@/lib/auth-client";
import { useUserProfileStore } from "@/stores/user-profile";
import { type ContentLevel } from "@/stores/ui";

/**
 * Normalize the raw `preferences.contentLevel`, which may contain legacy
 * "r18" / "r18g" values, into the current front-end ContentLevel union.
 */
function normalizeContentLevel(
  raw: string | null | undefined,
  fallbackShowNsfw: boolean | undefined,
): ContentLevel {
  if (raw === "safe") return "safe";
  if (raw === "sensitive" || raw === "r18" || raw === "r18g") return "sensitive";
  return fallbackShowNsfw ? "sensitive" : "safe";
}

/**
 * Returns the effective content mode for hub API queries.
 * Authenticated users: reads from profile preferences.
 * Guests: ALWAYS "safe" — Limitless content is signed-in only. The server
 * enforces the same rule (guest contentLevel params are ignored), so this
 * just keeps the client from issuing requests that would come back filtered.
 */
export function useContentLevel(): ContentLevel {
  const { data: session } = useSession();
  const profile = useUserProfileStore((s) => s.profile);

  if (session?.user) {
    return normalizeContentLevel(
      profile?.preferences?.contentLevel as string | undefined,
      profile?.preferences?.showNsfw as boolean | undefined,
    );
  }

  return "safe";
}

/**
 * Non-hook version for use in zustand store actions.
 * Reads directly from store state.
 */
export function getContentLevel(): ContentLevel {
  const profile = useUserProfileStore.getState().profile;
  if (profile) {
    return normalizeContentLevel(
      profile.preferences?.contentLevel as string | undefined,
      profile.preferences?.showNsfw as boolean | undefined,
    );
  }
  return "safe";
}
