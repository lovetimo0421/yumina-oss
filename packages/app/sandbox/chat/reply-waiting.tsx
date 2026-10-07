import { useEffect, useState } from "react";
import type { ChatStringKey } from "./i18n";

/**
 * What the chat shows between "sent" and the first token.
 *
 * Heavy cards take 40–56s to the first token (huge prompts on slow models).
 * A bare "…" for that long reads as a hang, so the line grows a little more
 * explicit the longer it waits — always on one line, inside the same box, so
 * nothing below it jumps when the wording changes.
 */

/** Seconds after which the wait is worth naming, then worth explaining. */
export const WAIT_THINKING_AFTER_MS = 5_000;
export const WAIT_HEAVY_AFTER_MS = 20_000;

export type WaitStage = "dots" | "thinking" | "heavy";

export function waitStage(elapsedMs: number): WaitStage {
  if (elapsedMs >= WAIT_HEAVY_AFTER_MS) return "heavy";
  if (elapsedMs >= WAIT_THINKING_AFTER_MS) return "thinking";
  return "dots";
}

const STAGE_KEYS: Record<Exclude<WaitStage, "dots">, ChatStringKey> = {
  thinking: "waitThinking",
  heavy: "waitHeavy",
};

export function ReplyWaitingIndicator({
  startedAt,
  t,
}: {
  startedAt: number;
  t: (key: ChatStringKey, vars?: Record<string, string | number>) => string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const elapsed = Math.max(0, now - startedAt);
  const stage = waitStage(elapsed);
  const seconds = Math.floor(elapsed / 1000);
  return (
    <div
      role="status"
      aria-live="polite"
      data-reply-waiting={stage}
      className="play-reply-waiting flex h-7 min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground/60"
    >
      <span className="play-reply-waiting__dots flex shrink-0 items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-current animate-pulse"
            style={{ animationDelay: `${i * 180}ms` }}
          />
        ))}
      </span>
      {stage !== "dots" && (
        <span className="min-w-0 truncate">
          {t(STAGE_KEYS[stage])}
          <span className="ml-1.5 tabular-nums text-muted-foreground/40">{t("waitElapsed", { seconds })}</span>
        </span>
      )}
    </div>
  );
}
