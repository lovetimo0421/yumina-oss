import type { TagLocale } from "@yumina/shared";
import i18n from "./i18n";

export function currentTagLocale(): TagLocale {
  // i18next loads locale chunks asynchronously, with Suspense disabled.
  const lang = i18n.language ?? "en";
  if (lang.startsWith("zh-Hant")) return "zh-Hant";
  if (lang.startsWith("zh")) return "zh";
  if (lang.startsWith("ja")) return "ja";
  if (lang.startsWith("es")) return "es";
  return "en";
}
