import { useEffect } from "react";
import { useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { TAB_TITLE_EN, titleKeyForPath, useDocumentTitleOverride } from "@/lib/document-title";

/** Keeps the browser tab named after what is on screen, in the UI language. Renders nothing. */
export function DocumentTitleSync() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const override = useDocumentTitleOverride();
  const { t } = useTranslation("common");

  const key = titleKeyForPath(pathname);
  const sectionTitle = t(`tabTitle.${key}`, { defaultValue: TAB_TITLE_EN[key] });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const next = override ?? sectionTitle;
    if (document.title !== next) document.title = next;
  }, [sectionTitle, override]);

  return null;
}
