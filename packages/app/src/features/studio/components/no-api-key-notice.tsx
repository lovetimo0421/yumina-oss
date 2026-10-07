import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";

/** The server's wording for "no key, no credits" on the assistant and on a
 *  playtest turn. Matched here so the panels can say it in the reader's
 *  language, with the settings page one click away, instead of echoing an
 *  English sentence with nowhere to go. */
export const NO_API_KEY_RE = /No API key configured/i;

export function isNoApiKeyError(text: string | null | undefined): boolean {
  return typeof text === "string" && NO_API_KEY_RE.test(text);
}

export function NoApiKeyNotice({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation("editor");
  const navigate = useNavigate();
  return (
    <div
      data-testid="no-api-key-notice"
      className={compact
        ? "rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-xs"
        : "flex flex-col items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-center text-xs"}
    >
      <p className="flex items-center gap-1.5 font-semibold text-amber-200">
        <KeyRound className="h-3.5 w-3.5 shrink-0" />
        {t("studio.noApiKey.title")}
      </p>
      <p className="mt-1 leading-relaxed text-foreground/75">{t("studio.noApiKey.body")}</p>
      <button
        type="button"
        onClick={() => navigate({ to: "/app/settings", hash: "ai-config" })}
        className="mt-2 rounded-md bg-amber-300 px-2.5 py-1 text-xs font-semibold text-black transition-colors hover:bg-amber-200"
      >
        {t("studio.noApiKey.action")}
      </button>
    </div>
  );
}
