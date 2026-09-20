import posthog from "posthog-js";
import { isAnalyticsEnabled } from "@/lib/analytics-enabled";
import { withStreamDeadline } from "./stream-deadline";

/**
 * Reverse proxies (Cloudflare 5xx pages, Railway edge errors) answer with a
 * full HTML document; dumping it verbatim into the chat as the error bubble
 * is unreadable. Surface the page <title> (e.g. "yumina.io | 524: A timeout
 * occurred") instead — the raw body still reaches telemetry via captureFailure.
 */
function summarizeErrorBody(text: string): string {
  const trimmed = text.trim();
  if (/^<!doctype html|^<html/i.test(trimmed)) {
    const title = trimmed.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
    return title || "The server returned an HTML error page";
  }
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

/**
 * Cloudflare edge statuses raised BEFORE the request reaches our origin:
 * 521 (origin refused), 522 (connect timeout), 523 (unreachable),
 * 525 (TLS handshake failed), 526 (invalid origin cert). Retrying these
 * cannot duplicate server-side work — the origin never saw attempt #1.
 * Sole caveat: 522 also has a rare post-connect mode (request bytes sent,
 * ACK never received) where the origin MAY have processed attempt #1.
 * Accepted risk: zero 522s in telemetry to date, and the dominant 522 mode
 * is a pre-connect timeout. Do NOT extend this reasoning to new statuses.
 *
 * That safety argument does NOT hold for 520/524 (the request may have
 * reached the origin and been processed), so those are deliberately excluded
 * — a blind onError re-POST is exactly what caused the duplicated-user-message
 * incident. Keep this set to pre-origin statuses only.
 *
 * One automatic retry makes the intermittent CF-colo→origin handshake
 * failures (2026-07 Malaysia / KUL-colo 525s) invisible: affected users
 * reported that a manual resend immediately succeeds.
 */
const RETRYABLE_EDGE_STATUS = new Set([521, 522, 523, 525, 526]);
const EDGE_RETRY_DELAY_MS = 2000;

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Where a stream failure originated — callers gate their retry policy on this.
 *
 * - "server":     the origin sent an explicit `event: error`. It handled the
 *                 failure and cleaned up; nothing is still generating.
 *                 Re-requesting is safe.
 * - "http":       the request got a non-2xx response before streaming began.
 * - "connection": the network layer broke (fetch threw, mid-stream read
 *                 failed, or the stream closed without a terminal event).
 *                 The origin may STILL be generating and will persist+charge
 *                 the reply it never delivered — a blind re-request duplicates
 *                 the turn (the cxyyy/Misa duplicated-reply incidents).
 */
export type SSEErrorOrigin = "server" | "http" | "connection";

export interface SSEErrorMeta {
  origin: SSEErrorOrigin;
  /** Present when the stream failed during the initial HTTP handshake. */
  status?: number;
}

export interface SSECallbacks {
  onStateValidation?: (audit: import("@yumina/shared").StateValidationAudit) => void;
  onText: (content: string) => void;
  onReasoning?: (content: string) => void;
  onSegment?: (data: { segment: Record<string, unknown> }) => void;
  onBg?: (data: { bg: string }) => void;
  onDone: (data: Record<string, unknown>) => void;
  onError: (error: string, meta?: SSEErrorMeta) => void;
}

/**
 * Connect to an SSE endpoint and process events.
 * Returns an AbortController so the caller can cancel the stream.
 */
export function connectSSE(
  url: string,
  options: {
    method: "POST";
    body: unknown;
    callbacks: SSECallbacks;
    /** Context attached to the `llm_stream_failed` telemetry event
     *  (e.g. { model, endpoint }). Lets us measure where/when streams drop. */
    telemetry?: Record<string, string | number | boolean | null | undefined>;
    /** No bytes/headers for this long means the connection is stalled. */
    idleTimeoutMs?: number;
  }
): AbortController {
  const controller = new AbortController();
  const startedAt = Date.now();

  // Record a stream failure so the client-side "connection lost" symptom is
  // measurable — it never reaches the server, so today we are blind to it.
  // `visibility_state` separates a real drop from mobile backgrounding;
  // `duration_ms` shows whether failures cluster near a proxy cap.
  const captureFailure = (errorType: string, rawMessage: string) => {
    try {
      if (typeof window === "undefined") return;
      if (isAnalyticsEnabled()) posthog.capture("llm_stream_failed", {
        error_type: errorType,
        raw_message: rawMessage.slice(0, 300),
        duration_ms: Date.now() - startedAt,
        visibility_state:
          typeof document !== "undefined" ? document.visibilityState : "unknown",
        ...options.telemetry,
      });
    } catch {
      /* analytics must never break streaming */
    }
  };

  const run = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      const response = await withStreamDeadline(fetch(url, {
        method: options.method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(options.body),
        signal: controller.signal,
      }), controller.signal, () => controller.abort(), options.idleTimeoutMs ?? 120_000);

      if (!response.ok) {
        const text = await response.text();
        const isEdgeStatus = RETRYABLE_EDGE_STATUS.has(response.status);
        // Non-edge statuses keep their canonical event name even when they
        // surface on the retry attempt (525→402 must still emit http_402):
        // PostHog dashboards/alerts exact-match on error_type.
        captureFailure(
          isEdgeStatus && attempt > 0
            ? `http_${response.status}_retry_failed`
            : `http_${response.status}`,
          text,
        );
        if (isEdgeStatus && attempt === 0) {
          // The failed handshake lived on one bad edge connection; waiting a
          // beat and retrying rides a fresh one. Aborting during the wait
          // throws AbortError → swallowed by run()'s caller like any abort.
          await abortableDelay(EDGE_RETRY_DELAY_MS, controller.signal);
          continue;
        }
        options.callbacks.onError(
          isEdgeStatus
            ? `Connection to the server failed (Cloudflare ${response.status}). Please try again in a moment.`
            : `HTTP ${response.status}: ${summarizeErrorBody(text)}`,
          { origin: "http", status: response.status },
        );
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        options.callbacks.onError("No response body", { origin: "connection" });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";  // Persists across chunks — event: and data: may arrive separately
      let receivedTerminalEvent = false;  // Track if done/error was received

      while (true) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await withStreamDeadline(reader.read(), controller.signal,
            () => { controller.abort(); void reader.cancel().catch(() => {}); }, options.idleTimeoutMs ?? 120_000));
        } catch (readErr) {
          if (readErr instanceof DOMException && readErr.name === "AbortError") return;
          const msg = readErr instanceof Error ? readErr.message : "Stream read failed";
          captureFailure("read_error", msg);
          options.callbacks.onError(msg, { origin: "connection" });
          return;
        }
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              switch (currentEvent) {
                case "text":
                  options.callbacks.onText(parsed.content ?? "");
                  break;
                case "state-validation":
                  options.callbacks.onStateValidation?.(parsed);
                  break;
                case "reasoning":
                  options.callbacks.onReasoning?.(parsed.content ?? "");
                  break;
                case "segment":
                  options.callbacks.onSegment?.(parsed);
                  break;
                case "bg":
                  options.callbacks.onBg?.(parsed);
                  break;
                case "done":
                  receivedTerminalEvent = true;
                  options.callbacks.onDone(parsed);
                  break;
                case "error":
                  receivedTerminalEvent = true;
                  // Preserve a structured error code (e.g. NO_CREDITS) so the
                  // chat store's onError can route it to the right toast/popup.
                  // The store JSON-parses the string and reads `.code`; a plain
                  // message (no code) passes through unchanged.
                  options.callbacks.onError(
                    parsed.code
                      ? JSON.stringify(parsed)
                      : (parsed.error ?? "Unknown error"),
                    { origin: "server" },
                  );
                  break;
              }
            } catch (parseErr) {
              console.warn("[SSE] Failed to parse data line:", data, parseErr);
            }
            currentEvent = "";
          }
        }
        if (receivedTerminalEvent) {
          void reader.cancel().catch(() => {});
          return;
        }
      }

      // Safety net: stream ended without a done/error event — prevent stuck loading state
      if (!receivedTerminalEvent) {
        console.warn("[SSE] Stream closed without done/error event");
        captureFailure("closed_no_terminal", "Stream closed without done/error event");
        options.callbacks.onError("Connection closed unexpectedly. Try regenerating.", { origin: "connection" });
      }
      return;
    }
  };

  run().catch((err) => {
    if (err instanceof DOMException && err.name === "AbortError") return;
    // Translate the browser-specific "fetch threw" error to a single
    // actionable line. Safari uses "Load failed", Chrome uses "Failed to
    // fetch", Firefox uses "NetworkError when attempting to fetch resource"
    // — none of these tell the user what to do, and a long-context request
    // hitting an upstream timeout is the most common cause. Keep the raw
    // message in the console so PostHog session recordings still capture it.
    const rawMessage = err instanceof Error ? err.message : String(err);
    console.error("[SSE] fetch failed:", err);
    const isNetworkError =
      /load failed|failed to fetch|networkerror|network request failed/i.test(rawMessage);
    captureFailure(isNetworkError ? "network" : "fetch_other", rawMessage);
    options.callbacks.onError(
      isNetworkError
        ? "Connection lost — the model may have timed out. Try regenerating, or switch to a faster model."
        : rawMessage,
      { origin: "connection" },
    );
  });

  return controller;
}
