import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, Compass } from "lucide-react";
import { getLandingRoute } from "@/edition/routes";
import { hasInternalBackEntry, navigateBackSafely } from "@/lib/safe-back";

/**
 * The one "this page doesn't exist" screen. `standalone` is the root-level
 * miss (no AppShell around it), so it paints its own background and logo;
 * inside /app it sits in the shell's content area and keeps the nav.
 */
export function NotFoundPage({ standalone = false }: { standalone?: boolean }) {
  const { t } = useTranslation("common");
  const router = useRouter();
  const home = getLandingRoute();
  const canGoBack = hasInternalBackEntry(router.history);

  const body = (
    <div className="flex w-full max-w-md flex-col items-center gap-5 px-6 text-center" data-testid="not-found-page">
      <p className="text-6xl font-black tracking-tight text-foreground/15 tabular-nums" aria-hidden>404</p>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-foreground">{t("notFound.title")}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("notFound.description")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {canGoBack && (
          <button
            type="button"
            onClick={() => navigateBackSafely(router.history, home)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("notFound.back")}
          </button>
        )}
        <a
          href={home}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            void router.navigate({ to: home });
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Compass className="h-4 w-4" />
          {t(home === "/app/library" ? "notFound.library" : "notFound.home")}
        </a>
      </div>
    </div>
  );

  if (!standalone) {
    return <div className="flex min-h-[60vh] w-full flex-1 items-center justify-center py-16">{body}</div>;
  }
  return (
    <div className="flex min-h-[100dvh] w-full flex-col bg-background text-foreground">
      <header className="flex h-14 items-center px-4 sm:px-8">
        <a href={home} className="flex items-center gap-2" aria-label="Yumina">
          <img src="/logo.png" alt="" className="h-8 w-8 object-contain" />
          <span className="text-sm font-semibold tracking-wide text-foreground/80">yumina</span>
        </a>
      </header>
      <main className="flex flex-1 items-center justify-center pb-16">{body}</main>
    </div>
  );
}
