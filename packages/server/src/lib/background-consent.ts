import { eq, sql } from "drizzle-orm";
import {
  BACKGROUND_CHARGE_FREE_OPTION,
  BACKGROUND_CHARGE_PENDING_PREF_KEY,
  backgroundChargeDecision,
  pendingBackgroundConsents,
  type BackgroundChargeChoice,
  type BackgroundChargeFeature,
  type BackgroundConsentNeeded,
} from "@yumina/shared";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
import { backgroundBillingApplies } from "./background-billing.js";
import { calculateCost } from "./credit-service.js";
import { FREE_ROUTER_MODEL, isZeroCostPlayModel } from "./llm/fallback-models.js";

/**
 * The gate in front of every background AI that bills mushies on its own
 * (recap, session memory, state guard, card AIs, run summary). Jason,
 * 2026-11-08: the first time one of them would charge, ask; never charge a
 * player who has not answered. The server enforces it: an AI with no answer
 * does not make its paid call, whatever the client shows.
 *
 * What runs is decided per call:
 *  - the player's own key, an unlimited plan, or a model that costs nothing:
 *    runs, never asks; except that an AI making several calls a run on the
 *    player's own key (the recap, `askOnOwnKey`) asks once too, since their
 *    provider may bill each call (2026-11-08: 64 recap calls on one relay);
 *  - "allow" (or "don't ask again"): runs and is charged;
 *  - "free": runs on Yumina Free instead, where that can do the job;
 *  - "skip": does not run;
 *  - no answer yet: does not run, and leaves a note the next reply's `done`
 *    event carries to the dialog. Recap and memory work from cursors, so a
 *    skipped run is caught up by the next one; nothing is lost.
 */

/** Yumina Free: the model a "use the free model" answer runs on. */
export const FREE_BACKGROUND_MODEL = FREE_ROUTER_MODEL;

export type BackgroundChargeGate =
  | {
    run: true;
    /** The model to call: the requested one, or Yumina Free on a "free" answer. */
    model: string;
    /** True when the call may cost mushies (the player allowed it). */
    charged: boolean;
    /** The player chose the free model for this AI. */
    viaFree: boolean;
  }
  | { run: false; reason: "undecided" | "skip"; consent?: BackgroundConsentNeeded };

async function loadPreferences(userId: string): Promise<unknown> {
  // The primary: a decision saved a moment ago must be seen (readOwn policy).
  const [row] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.preferences ?? null;
}

/** The player's answer for one AI. */
export async function loadBackgroundChargeDecision(userId: string, feature: BackgroundChargeFeature): Promise<BackgroundChargeChoice | "undecided"> {
  return backgroundChargeDecision(await loadPreferences(userId), feature);
}

/** Rough mushies for one call of this size, to one decimal; null when nothing is charged. */
export async function estimateCallCredits(model: string, promptTokens: number, completionTokens: number): Promise<number | null> {
  if (isZeroCostPlayModel(model)) return null;
  const cost = await calculateCost(model, Math.max(0, Math.round(promptTokens)), Math.max(0, Math.round(completionTokens)));
  return cost > 0 ? Math.max(0.1, Math.round(cost * 10) / 10) : null;
}

/** Leave a note for the dialog. Written once per AI; the player's answer clears it. */
export async function recordPendingBackgroundConsent(userId: string, consent: BackgroundConsentNeeded): Promise<void> {
  const entry = JSON.stringify({ model: consent.model, estCredits: consent.estCredits, ...(consent.ownKey ? { ownKey: true } : {}), at: new Date().toISOString() });
  const key = BACKGROUND_CHARGE_PENDING_PREF_KEY;
  await db.update(user).set({
    preferences: sql`coalesce(${user.preferences}, '{}'::jsonb) || jsonb_build_object(${key}::text,
      (CASE WHEN jsonb_typeof(${user.preferences}->${key}::text) = 'object' THEN ${user.preferences}->${key}::text ELSE '{}'::jsonb END)
      || jsonb_build_object(${consent.feature}::text, ${entry}::jsonb))`,
  }).where(sql`${user.id} = ${userId} AND (${user.preferences}->${key}::text->${consent.feature}::text) IS NULL`);
}

/**
 * May this background AI make its call, and on which model?
 * `isByok`: the caller resolved the provider and it is the player's own key.
 * `estimate`: rough mushies for one run on `model` (for the dialog).
 */
export async function gateBackgroundCharge(args: {
  userId: string;
  feature: BackgroundChargeFeature;
  model: string;
  isByok?: boolean;
  /** Ask on the player's own key too (no mushies; their provider bills). */
  askOnOwnKey?: boolean;
  estimate?: () => Promise<number | null>;
}): Promise<BackgroundChargeGate> {
  const uncharged: BackgroundChargeGate = { run: true, model: args.model, charged: false, viaFree: false };
  // The player's own key or machine: they pay their provider, not us.
  if (args.isByok) {
    if (!args.askOnOwnKey) return uncharged;
    const decision = await loadBackgroundChargeDecision(args.userId, args.feature);
    if (decision === "allow") return uncharged;
    if (decision === "free" && BACKGROUND_CHARGE_FREE_OPTION[args.feature]) {
      return { run: true, model: FREE_BACKGROUND_MODEL, charged: false, viaFree: true };
    }
    if (decision === "skip" || decision === "free") return { run: false, reason: "skip" };
    const consent: BackgroundConsentNeeded = {
      feature: args.feature,
      model: args.model,
      estCredits: null,
      hasFreeOption: BACKGROUND_CHARGE_FREE_OPTION[args.feature],
      ownKey: true,
    };
    await recordPendingBackgroundConsent(args.userId, consent).catch((err) =>
      console.warn("[BackgroundConsent] could not record the question:", err instanceof Error ? err.message : err));
    return { run: false, reason: "undecided", consent };
  }
  // Unlimited plans are never charged for background work.
  if (!await backgroundBillingApplies(args.userId)) return uncharged;
  // A model that costs nothing never asks. (The recap and memory runs do not
  // fall back from a free model to a priced one: see their generators.)
  if (isZeroCostPlayModel(args.model) || (await calculateCost(args.model, 4_000, 500)) <= 0) return uncharged;
  const decision = await loadBackgroundChargeDecision(args.userId, args.feature);
  if (decision === "allow") return { run: true, model: args.model, charged: true, viaFree: false };
  if (decision === "free" && BACKGROUND_CHARGE_FREE_OPTION[args.feature]) {
    return { run: true, model: FREE_BACKGROUND_MODEL, charged: false, viaFree: true };
  }
  if (decision === "skip" || decision === "free") return { run: false, reason: "skip" };
  const consent: BackgroundConsentNeeded = {
    feature: args.feature,
    model: args.model,
    estCredits: await args.estimate?.().catch(() => null) ?? null,
    hasFreeOption: BACKGROUND_CHARGE_FREE_OPTION[args.feature],
  };
  await recordPendingBackgroundConsent(args.userId, consent).catch((err) =>
    console.warn("[BackgroundConsent] could not record the question:", err instanceof Error ? err.message : err));
  return { run: false, reason: "undecided", consent };
}

/**
 * The `consentNeeded` field of a reply's `done` event: the AIs waiting for an
 * answer (notes left by earlier runs, plus any this turn found). Never throws:
 * the reply is already saved.
 */
export async function consentNeededForDone(userId: string, found: Array<BackgroundConsentNeeded | null | undefined> = []): Promise<{ consentNeeded?: BackgroundConsentNeeded[] }> {
  try {
    const preferences = await loadPreferences(userId);
    const out = pendingBackgroundConsents(preferences);
    for (const item of found) {
      if (!item || out.some((seen) => seen.feature === item.feature)) continue;
      if (backgroundChargeDecision(preferences, item.feature) !== "undecided") continue;
      out.push(item);
    }
    return out.length ? { consentNeeded: out } : {};
  } catch {
    return {};
  }
}
