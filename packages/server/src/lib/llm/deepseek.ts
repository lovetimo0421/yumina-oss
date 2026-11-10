import type { GenerateParams } from "./types.js";

export const DEEPSEEK_PROGRESS_TIMEOUT_MS = 90_000;
export const DEEPSEEK_REPLY_TIMEOUT_MS = 120_000;

export function isOfficialDeepSeekEndpoint(baseUrl: string): boolean {
  return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
}

/** Native DeepSeek controls; never send these to arbitrary compatible proxies.
 * https://api-docs.deepseek.com/guides/thinking_mode/ */
export function applyDeepSeekReasoning(body: Record<string, unknown>, params: GenerateParams) {
  if (params.disableReasoning || params.reasoningEffort === "none") {
    body.thinking = { type: "disabled" };
    body.reasoning_effort = "none";
    return;
  }
  const levels: Record<string, string> = {
    minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max",
  };
  const effort = params.reasoningEffort && levels[params.reasoningEffort];
  if (effort) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = effort;
  }
}

/** Covers headers AND body. Transport keepalives do not count as model progress. */
export function deepSeekDeadline(enabled: boolean, streaming: boolean, parent?: AbortSignal) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    clearTimeout(timer);
    if (!enabled || signal.aborted) return;
    timer = setTimeout(() => controller.abort(new Error(streaming
      ? "DeepSeek response timeout: no model output for 90 seconds. The request was stopped and was not automatically resent."
      : "DeepSeek response timeout: no complete reply within 120 seconds. The request was stopped and was not automatically resent.")),
    streaming ? DEEPSEEK_PROGRESS_TIMEOUT_MS : DEEPSEEK_REPLY_TIMEOUT_MS);
  };
  const stop = () => clearTimeout(timer);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  signal.addEventListener("abort", stop, { once: true });
  reset();
  return {
    signal,
    progress: reset,
    dispose() { stop(); signal.removeEventListener("abort", stop); },
  };
}
