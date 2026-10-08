import { useEffect, useState } from "react";
import type { SandboxedYuminaAPI } from "../sandbox-context";
import type { SandboxMessage } from "./types";
import type { makeChatT } from "./i18n";

type T = ReturnType<typeof makeChatT>;
type Key = Parameters<T>[0];

const REASON_KEY: Record<string, Key> = {
  busy: "turnImageBusy",
  timeout: "turnImageTimeout",
  unavailable: "turnImageUnavailable",
};

// Most pictures land in 5-15s. One that lands on a drawing machine that is
// still loading its model takes 70-95s, so past this the player is told why.
const SLOW_AFTER_MS = 20_000;

/** "Drawing this scene…", and past SLOW_AFTER_MS a line saying the wait is longer than usual. */
export function TurnImageDrawingLabel({ t }: { t: T }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex max-w-[16rem] flex-col items-center gap-1.5 px-3 text-center">
      <span className="flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        {t("turnImageDrawing")}
      </span>
      {slow && <span className="text-[11px] leading-snug opacity-80">{t("turnImageSlow")}</span>}
    </div>
  );
}

/**
 * The per-turn picture while it draws (a placeholder the size of the picture,
 * so the reply doesn't jump when it lands) and, if it wasn't drawn, one quiet
 * line saying why. The status is client-only: after a reload only the finished
 * picture (part of the reply) and the "draw this scene" action remain.
 */
export function TurnImageState({ message, api, t }: { message: SandboxMessage; api: SandboxedYuminaAPI; t: T }) {
  const state = message.turnImage;
  if (!state) return null;

  if (state.status === "drawing") {
    return (
      <div className="my-3 flex justify-center" role="status" aria-live="polite">
        <div className="w-full rounded-lg border border-border/60 bg-background/60 p-2" style={{ maxWidth: "24rem" }}>
          <div className="flex aspect-[832/1216] w-full items-center justify-center rounded-md bg-muted/40 text-xs text-muted-foreground">
            <TurnImageDrawingLabel t={t} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" role="status">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-amber-500/80" aria-hidden="true">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      {state.reason === "credits" ? (
        <>
          <span>{t("turnImageNoCredits")}</span>
          <button
            type="button"
            onClick={() => api.openCreditTopUp()}
            className="hover-surface rounded px-1.5 py-0.5 font-medium text-primary [@media(hover:none)]:min-h-8"
          >
            {t("turnImageTopUp")}
          </button>
        </>
      ) : (
        <>
          <span>{t("turnImageFailed", { reason: t(REASON_KEY[state.reason] ?? "turnImageUnavailable") })}</span>
          <button
            type="button"
            onClick={() => { void api.illustrateMessage(message.id); }}
            className="hover-surface rounded px-1.5 py-0.5 font-medium text-primary [@media(hover:none)]:min-h-8"
          >
            {t("turnImageRetry")}
          </button>
        </>
      )}
    </div>
  );
}
