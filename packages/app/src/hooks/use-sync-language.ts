import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUserProfileStore } from "@/stores/user-profile";
import { clampLanguage } from "@/lib/i18n";
import { ensureTraditionalizer, isTraditionalLocale } from "@/lib/traditionalize";

/**
 * Syncs the i18n language with the user's profile preference.
 * Call once in AppShell.
 */
export function useSyncLanguage() {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.resolvedLanguage ?? i18n.language;
  const language = useUserProfileStore(
    (s) => (s.profile?.preferences?.language as string) ?? null
  );

  useEffect(() => {
    if (language) {
      const clamped = clampLanguage(language);
      if (clamped !== i18n.language) {
        void i18n.changeLanguage(clamped);
      }
    }
  }, [language, i18n]);

  useEffect(() => {
    document.documentElement.lang = clampLanguage(currentLanguage);
  }, [currentLanguage]);

  // Prefetch the Simplified→Traditional converter chunk for Traditional users so
  // auto-translated content (posts, reviews) renders Traditional without a
  // first-view flicker. No-op (and no chunk download) for every other locale.
  useEffect(() => {
    if (isTraditionalLocale(currentLanguage)) ensureTraditionalizer();
  }, [currentLanguage]);
}
