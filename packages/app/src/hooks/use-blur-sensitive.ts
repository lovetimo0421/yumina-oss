import { useSession } from "@/lib/auth-client";
import { useUserProfileStore } from "@/stores/user-profile";
import { useUiStore } from "@/stores/ui";

/**
 * Effective "should sensitive thumbnails be blurred?" preference.
 * Auth users → preferences.blurSensitive (default true).
 * Guests → useUiStore.guestBlurSensitive (default true).
 */
export function useBlurSensitive(): boolean {
  const { data: session } = useSession();
  const profile = useUserProfileStore((s) => s.profile);
  const guestBlur = useUiStore((s) => s.guestBlurSensitive);

  if (session?.user || profile) {
    return profile?.preferences?.blurSensitive !== false;
  }
  return guestBlur;
}
