/**
 * Asking before background AIs spend a player's mushies (2026-11-08).
 *
 * Five AIs run on their own and bill the player without the player pressing
 * anything for that charge. The first time one of them would charge, the
 * player is asked once, in one dialog: allow it, run it on the free model
 * (where a free model can do the job), or not run it. Nobody is grandfathered.
 *
 * user.preferences.backgroundCharges holds the player's answers (written by
 * the client through PATCH /api/users/me). user.preferences.backgroundChargePending
 * is server-owned: an AI that wanted to charge and had no answer leaves a note
 * there, and the next reply's `done` event carries it to the dialog.
 */

export const BACKGROUND_CHARGE_FEATURES = ["recap", "memory", "guard", "cardAi", "runSummary"] as const;
export type BackgroundChargeFeature = (typeof BACKGROUND_CHARGE_FEATURES)[number];

/** allow: charge mushies. free: run on Yumina Free. skip: do not run. */
export type BackgroundChargeChoice = "allow" | "free" | "skip";

/** Which AIs can do their job on Yumina Free. The others are offered "skip". */
export const BACKGROUND_CHARGE_FREE_OPTION: Readonly<Record<BackgroundChargeFeature, boolean>> = {
  recap: true,
  memory: true,
  guard: true,
  cardAi: false,
  runSummary: false,
};

export interface BackgroundChargePrefs {
  /** "Don't ask again": every AI may charge. */
  allowAll?: boolean;
  features?: Partial<Record<BackgroundChargeFeature, BackgroundChargeChoice>>;
  /**
   * "Not this time" on an AI with no free model: it does not run until this
   * moment (ISO), and then the player is asked again. Not a saved answer.
   */
  snoozedUntil?: Partial<Record<BackgroundChargeFeature, string>>;
}

/** How long "not this time" holds before the player is asked again. */
export const BACKGROUND_CHARGE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** One AI waiting for the player's answer. */
export interface BackgroundConsentNeeded {
  feature: BackgroundChargeFeature;
  model: string;
  /** Rough mushies per run; null when unknown. */
  estCredits: number | null;
  hasFreeOption: boolean;
  /** It would run on the player's own API, which bills them, not us. */
  ownKey?: boolean;
}

export const BACKGROUND_CHARGES_PREF_KEY = "backgroundCharges";
export const BACKGROUND_CHARGE_PENDING_PREF_KEY = "backgroundChargePending";

export function isBackgroundChargeFeature(value: unknown): value is BackgroundChargeFeature {
  return typeof value === "string" && (BACKGROUND_CHARGE_FEATURES as readonly string[]).includes(value);
}

/** The saved answers, cleaned of anything a client should not have sent. */
export function readBackgroundChargePrefs(preferences: unknown): BackgroundChargePrefs {
  const raw = (preferences as Record<string, unknown> | null | undefined)?.[BACKGROUND_CHARGES_PREF_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as { allowAll?: unknown; features?: unknown; snoozedUntil?: unknown };
  const out: BackgroundChargePrefs = {};
  if (source.allowAll === true) out.allowAll = true;
  if (source.features && typeof source.features === "object" && !Array.isArray(source.features)) {
    const features: NonNullable<BackgroundChargePrefs["features"]> = {};
    for (const [key, value] of Object.entries(source.features as Record<string, unknown>)) {
      if (!isBackgroundChargeFeature(key)) continue;
      if (value === "allow" || value === "skip") features[key] = value;
      // "free" only where a free model can do the job; elsewhere it means skip.
      else if (value === "free") features[key] = BACKGROUND_CHARGE_FREE_OPTION[key] ? "free" : "skip";
    }
    if (Object.keys(features).length) out.features = features;
  }
  if (source.snoozedUntil && typeof source.snoozedUntil === "object" && !Array.isArray(source.snoozedUntil)) {
    const snoozed: NonNullable<BackgroundChargePrefs["snoozedUntil"]> = {};
    // A client cannot snooze much past one window from now (two, for clock skew).
    const latest = Date.now() + 2 * BACKGROUND_CHARGE_SNOOZE_MS;
    for (const [key, value] of Object.entries(source.snoozedUntil as Record<string, unknown>)) {
      if (!isBackgroundChargeFeature(key) || typeof value !== "string") continue;
      const at = Date.parse(value);
      if (!Number.isFinite(at) || at > latest) continue;
      snoozed[key] = new Date(at).toISOString();
    }
    if (Object.keys(snoozed).length) out.snoozedUntil = snoozed;
  }
  return out;
}

/** Is this AI inside a "not this time" window? */
export function isBackgroundChargeSnoozed(prefs: BackgroundChargePrefs, feature: BackgroundChargeFeature, now = Date.now()): boolean {
  const until = prefs.snoozedUntil?.[feature];
  return until != null && Date.parse(until) > now;
}

/**
 * The player's answer for one AI, or "undecided". "Don't ask again" wins over
 * everything; a "not this time" window reads as "skip" until it ends.
 */
export function backgroundChargeDecision(preferences: unknown, feature: BackgroundChargeFeature, now = Date.now()): BackgroundChargeChoice | "undecided" {
  const prefs = readBackgroundChargePrefs(preferences);
  if (prefs.allowAll) return "allow";
  const saved = prefs.features?.[feature];
  if (saved) return saved;
  return isBackgroundChargeSnoozed(prefs, feature, now) ? "skip" : "undecided";
}

/** The waiting AIs the player has not answered yet. */
export function pendingBackgroundConsents(preferences: unknown): BackgroundConsentNeeded[] {
  const raw = (preferences as Record<string, unknown> | null | undefined)?.[BACKGROUND_CHARGE_PENDING_PREF_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: BackgroundConsentNeeded[] = [];
  for (const feature of BACKGROUND_CHARGE_FEATURES) {
    const entry = (raw as Record<string, unknown>)[feature] as { model?: unknown; estCredits?: unknown; ownKey?: unknown } | undefined;
    if (!entry || typeof entry !== "object") continue;
    if (backgroundChargeDecision(preferences, feature) !== "undecided") continue;
    out.push({
      feature,
      model: typeof entry.model === "string" ? entry.model : "",
      estCredits: typeof entry.estCredits === "number" && Number.isFinite(entry.estCredits) ? entry.estCredits : null,
      hasFreeOption: BACKGROUND_CHARGE_FREE_OPTION[feature],
      ...(entry.ownKey === true ? { ownKey: true } : {}),
    });
  }
  return out;
}

/** Parse a `done` event's consentNeeded field (untrusted wire data). */
export function parseBackgroundConsentNeeded(value: unknown): BackgroundConsentNeeded[] {
  if (!Array.isArray(value)) return [];
  const out: BackgroundConsentNeeded[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (!isBackgroundChargeFeature(entry.feature) || out.some((seen) => seen.feature === entry.feature)) continue;
    out.push({
      feature: entry.feature,
      model: typeof entry.model === "string" ? entry.model : "",
      estCredits: typeof entry.estCredits === "number" && Number.isFinite(entry.estCredits) ? entry.estCredits : null,
      hasFreeOption: BACKGROUND_CHARGE_FREE_OPTION[entry.feature],
      ...(entry.ownKey === true ? { ownKey: true } : {}),
    });
  }
  return out;
}
