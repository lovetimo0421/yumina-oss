import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUserProfileStore } from "@/stores/user-profile";
import { resolveDisplayMacros } from "@/lib/resolve-display-macros";

/**
 * Card descriptions are authored with chat macros ("{{user}} wakes up in
 * {{char}}'s house") and were printed literally on Discover, the world modal
 * and the library. For display, {{user}} becomes the viewer's name (a
 * localized "you" for guests) and {{char}} the card's name — cards don't
 * expose a separate character name outside the chat.
 */
export function resolveCardTextMacros(text: string, viewerName: string, cardName: string): string {
  if (!text.includes("{{")) return text;
  return resolveDisplayMacros(text, viewerName, cardName);
}

export function useCardTextMacros(): (text: string, cardName: string) => string {
  const { t } = useTranslation("common");
  const name = useUserProfileStore((s) => s.profile?.name || s.profile?.username || "");
  const viewerName = name || t("macroYou");
  return useCallback(
    (text: string, cardName: string) => resolveCardTextMacros(text, viewerName, cardName),
    [viewerName],
  );
}
