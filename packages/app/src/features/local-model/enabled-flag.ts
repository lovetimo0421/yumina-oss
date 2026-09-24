/**
 * The one place that knows whether this browser has volunteered its GPU.
 *
 * Split out of the store so the app shell can ask the question without pulling
 * the bridge and the detector into the entry chunk — the answer is "no" for
 * almost every visitor, and that path should cost nothing.
 */

const ENABLED_KEY = "yumina-local-model-enabled";

/** True when the player turned the bridge on and hasn't turned it off. */
export function isLocalModelArmed(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLocalModelArmed(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* private browsing — the setting just won't survive a reload */
  }
}

/** Model ids the bridge publishes. Everything downstream keys off this prefix. */
export function isLocalModelId(modelId: string): boolean {
  return modelId.startsWith("local/");
}
