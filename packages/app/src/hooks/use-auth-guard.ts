import { useSession } from "@/lib/auth-client";
import { useAuthModalStore } from "@/stores/auth-modal";
import { useTranslation } from "react-i18next";
import { useEdition } from "@/edition/edition";

const AUTH_ACTION_TRANSLATION_KEYS = {
    "continue the story": "auth.actions.continueTheStory",
    "continue playing": "auth.actions.continuePlaying",
    "create worlds": "auth.actions.createWorlds",
    "favorite worlds": "auth.actions.favoriteWorlds",
    "follow creators": "auth.actions.followCreators",
    "fork worlds": "auth.actions.forkWorlds",
    "publish bundles": "auth.actions.publishBundles",
    "publish worlds": "auth.actions.publishWorlds",
    "reply to reviews": "auth.actions.replyToReviews",
    "save bundles": "auth.actions.saveBundles",
    "save worlds to your library": "auth.actions.saveWorldsToLibrary",
    "send messages": "auth.actions.sendMessages",
    "view sensitive content": "auth.actions.viewSensitiveContent",
    "write reviews": "auth.actions.writeReviews",
} as const;

type AuthAction = keyof typeof AUTH_ACTION_TRANSLATION_KEYS;

/**
 * Hook that provides auth state and a function to gate protected actions.
 *
 * Usage:
 * ```tsx
 * const { isAuthenticated, requireAuth } = useAuthGuard();
 * const handlePublish = () => {
 *   if (!requireAuth("publish worlds")) return;
 *   // ... proceed with publish
 * };
 * ```
 */
export function useAuthGuard() {
    const { data: session, isPending } = useSession();
    const openModal = useAuthModalStore((s) => s.open);
    const { t } = useTranslation("common");
    const singleUser = useEdition().auth.mode === "single-user";

    const isAuthenticated = !!session?.user;

    const requireAuth = (action: string): boolean => {
        if (isAuthenticated) return true;
        // Single-user mode has no login page: the local account session is
        // minted by the /app route loader, so never open the login modal.
        if (singleUser) return true;

        const translationKey = AUTH_ACTION_TRANSLATION_KEYS[action as AuthAction];
        openModal(translationKey ? t(translationKey) : action);
        return false;
    };

    return { isAuthenticated, isPending, requireAuth, session };
}
