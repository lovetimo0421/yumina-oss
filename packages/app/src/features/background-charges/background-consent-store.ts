import { create } from "zustand";
import {
  BACKGROUND_CHARGE_SNOOZE_MS,
  BACKGROUND_CHARGES_PREF_KEY,
  parseBackgroundConsentNeeded,
  pendingBackgroundConsents,
  readBackgroundChargePrefs,
  type BackgroundChargeChoice,
  type BackgroundChargeFeature,
  type BackgroundChargePrefs,
  type BackgroundConsentNeeded,
} from "@yumina/shared";

const apiBase = import.meta.env?.VITE_API_URL || "";

/**
 * The background AIs waiting for the player's answer before they charge
 * mushies. A reply's `done` event (consentNeeded) or the profile's waiting
 * notes fill it; BackgroundConsentDialog shows it. The server holds the paid
 * call until the answer is saved, so closing the dialog only asks again later.
 */
interface BackgroundConsentState {
  asks: BackgroundConsentNeeded[];
  /** Another first-visit question (the display-mode chooser) is open: wait for it. */
  held: boolean;
}

export const useBackgroundConsentStore = create<BackgroundConsentState>(() => ({ asks: [], held: false }));

/** Keep the dialog back while another question is on screen; it shows once that closes. */
export function setBackgroundConsentHeld(held: boolean): void {
  if (useBackgroundConsentStore.getState().held !== held) useBackgroundConsentStore.setState({ held });
}

/** Queue the AIs a `done` event (or the profile) says are waiting. */
export function askBackgroundConsent(raw: unknown): void {
  const incoming = parseBackgroundConsentNeeded(raw);
  if (incoming.length === 0) return;
  useBackgroundConsentStore.setState((state) => ({
    asks: [...state.asks, ...incoming.filter((item) => !state.asks.some((seen) => seen.feature === item.feature))],
  }));
}

/** Show the notes the server left while no reply was there to carry them. */
export function askPendingBackgroundConsent(preferences: unknown): void {
  askBackgroundConsent(pendingBackgroundConsents(preferences));
}

/** Read the profile's waiting notes fresh (they are written in the background) and ask. */
export async function checkPendingBackgroundConsent(): Promise<void> {
  const res = await fetch(`${apiBase}/api/users/me`, { credentials: "include", cache: "no-store" }).catch(() => null);
  if (!res?.ok) return;
  const body = await res.json().catch(() => null) as { data?: { preferences?: unknown } } | null;
  askPendingBackgroundConsent(body?.data?.preferences);
}

export function closeBackgroundConsent(): void {
  useBackgroundConsentStore.setState({ asks: [] });
}

/**
 * The answer for each AI the player declines charging for: the free model
 * where one can do the job, otherwise "not this time" (asked again later).
 */
export function declinedChoice(ask: Pick<BackgroundConsentNeeded, "hasFreeOption">): BackgroundChargeChoice | "snooze" {
  return ask.hasFreeOption ? "free" : "snooze";
}

/** The saved answers after this one (pure: the dialog and its test share it). */
export function nextBackgroundChargePrefs(
  current: BackgroundChargePrefs,
  answers: Partial<Record<BackgroundChargeFeature, BackgroundChargeChoice | "ask" | "snooze">>,
  allowAll?: boolean,
  now = Date.now(),
): BackgroundChargePrefs {
  const features = { ...current.features };
  const snoozedUntil = { ...current.snoozedUntil };
  for (const [feature, choice] of Object.entries(answers) as Array<[BackgroundChargeFeature, BackgroundChargeChoice | "ask" | "snooze"]>) {
    delete snoozedUntil[feature];
    if (choice === "snooze") {
      delete features[feature];
      snoozedUntil[feature] = new Date(now + BACKGROUND_CHARGE_SNOOZE_MS).toISOString();
    } else if (choice === "ask") delete features[feature];
    else features[feature] = choice;
  }
  // Windows that have ended are dropped.
  for (const [feature, until] of Object.entries(snoozedUntil)) {
    if (!until || Date.parse(until) <= now) delete snoozedUntil[feature as BackgroundChargeFeature];
  }
  const all = allowAll ?? current.allowAll === true;
  return { ...(all ? { allowAll: true } : {}), features, ...(Object.keys(snoozedUntil).length ? { snoozedUntil } : {}) };
}

/** The saved answers in a profile's preferences. */
export function currentBackgroundChargePrefs(preferences: unknown): BackgroundChargePrefs {
  return readBackgroundChargePrefs(preferences);
}

/** Save through PATCH /api/users/me (preferences.backgroundCharges). */
export async function saveBackgroundChargePrefs(next: BackgroundChargePrefs): Promise<boolean> {
  const res = await fetch(`${apiBase}/api/users/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ preferences: { [BACKGROUND_CHARGES_PREF_KEY]: next } }),
  }).catch(() => null);
  if (!res?.ok) return false;
  // Loaded lazily: this module rides along with the SSE client.
  const { useUserProfileStore } = await import("@/stores/user-profile");
  await useUserProfileStore.getState().forceFetchProfile();
  return true;
}
