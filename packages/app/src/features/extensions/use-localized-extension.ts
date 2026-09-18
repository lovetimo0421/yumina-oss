import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ExtensionDetail, ExtensionSummary } from "@yumina/shared";
import { localizeExtensionDetail, localizeExtensionSummary } from "./localize-extension";

export function useLocalizedExtension(extension: ExtensionSummary) {
  const { t, i18n } = useTranslation("extensions");
  return useMemo(
    () => localizeExtensionSummary(extension, t),
    [extension, t, i18n.language],
  );
}

export function useLocalizedExtensionDetail(
  extension: ExtensionSummary,
  detail: ExtensionDetail | undefined,
) {
  const { t, i18n } = useTranslation("extensions");
  return useMemo(() => {
    if (!detail) return null;
    return localizeExtensionDetail(detail, t);
  }, [extension.key, detail, t, i18n.language]);
}
