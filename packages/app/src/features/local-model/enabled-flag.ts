/**
 * The one place that knows whether this browser has volunteered its GPU.
 *
 * Split out of the store so the app shell can ask the question without pulling
 * the bridge and the detector into the entry chunk — the answer is "no" for
 * almost every visitor, and that path should cost nothing.
 */

import { ensureEditionLoaded } from "@/edition/edition";

const ENABLED_KEY = "yumina-local-model-enabled";

/** True when the player turned the bridge on and hasn't turned it off. */
export function isLocalModelArmed(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

/** True when the player turned the bridge off: never reconnect it behind their back. */
export function isLocalModelDeclined(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "0";
  } catch {
    return false;
  }
}

export function setLocalModelArmed(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* private browsing — the setting just won't survive a reload */
  }
}

function isLoopbackPage(): boolean {
  try {
    const host = window.location.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Whether to look for a local runtime without being asked: only on the
 * self-hosted edition, opened on the machine it runs on. There the page and
 * the runtime share the loopback address, so probing needs no browser
 * permission and finds the computer the player is sitting at. On the hosted
 * site the same probe would raise Chrome's local-network prompt for every
 * visitor, so there it stays something the player turns on.
 */
export async function shouldAutoDetectLocalModel(): Promise<boolean> {
  if (isLocalModelDeclined() || !isLoopbackPage()) return false;
  return (await ensureEditionLoaded()).edition === "local";
}

/** Model ids the bridge publishes. Everything downstream keys off this prefix. */
export function isLocalModelId(modelId: string): boolean {
  return modelId.startsWith("local/");
}
