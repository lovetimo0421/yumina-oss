import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import LanguageDetector from "i18next-browser-languagedetector";
import { SUPPORTED_LANGUAGES, clampLanguage, contentLanguage } from "./language-clamp";
import { IS_LOCAL_BUILD } from "@/edition/edition";

// Custom detector: reads from user profile store if available
const profileDetector = {
  name: "profile-preference",
  lookup(): string {
    try {
      // Read from localStorage persisted Zustand store
      const raw = localStorage.getItem("yumina-ui");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.state?.locale) {
          return clampLanguage(parsed.state.locale);
        }
      }
    } catch {
      // ignore
    }
    return clampLanguage(navigator.language);
  },
};

const languageDetector = new LanguageDetector();
languageDetector.addDetector(profileDetector);

i18n
  .use(languageDetector)
  .use(
    resourcesToBackend(
      (language: string, namespace: string) => {
        // Production (Docker/Linux) is case-sensitive: the folder on disk is
        // exactly `zh-Hant`, so normalize whatever casing i18next resolves to
        // before building the dynamic import path.
        const folder = /^zh-hant$/i.test(language) ? "zh-Hant" : language;
        return import(`../locales/${folder}/${namespace}.json`);
      }
    )
  )
  .use(initReactI18next)
  .init({
    // Untranslated/missing zh-Hant keys fall through to Simplified first (still
    // readable Chinese), then English — never straight to English.
    fallbackLng: { "zh-Hant": ["zh", "en"], default: ["en"] },
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    defaultNS: "common",
    // achievements is a hosted namespace; the open-source export drops the file.
    ns: ["common", "room", "toasts", "templates-content", ...(IS_LOCAL_BUILD ? [] : ["achievements"])],
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ["querystring", "profile-preference", "navigator"],
      lookupQuerystring: "lang",
      caches: [],
      // Clamp whatever a detector hands us (?lang=zh-TW, a Hong Kong navigator, a
      // stale stored locale) to a supported UI locale, routing Traditional
      // regions to zh-Hant, before i18next attempts to resolve it.
      convertDetectedLanguage: clampLanguage,
    },
    react: {
      useSuspense: false,
    },
  });

export { SUPPORTED_LANGUAGES, clampLanguage, contentLanguage };
export default i18n;
