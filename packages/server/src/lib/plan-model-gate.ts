import { validateModelAccess } from "./credit-service.js";
import { getModelPrice } from "./model-price-cache.js";
import type { PlanId } from "./plan-config.js";
import { resolveProviderForModel } from "./resolve-provider.js";

/**
 * Background calls (story summary, session memory, summaryception, card AI
 * stations) run on a model the player or the creator picked, outside the chat
 * turn's own plan check. On the official key that model must still respect
 * the player's plan: when it doesn't, run on `fallback` instead of failing.
 * BYOK, local and custom keys keep the requested model — the player pays the
 * provider directly, so plan tiers don't apply. A model no key can run at all
 * also gets `fallback`.
 */
export async function planAllowedModel(userId: string, model: string, fallback: string): Promise<string> {
  if (model === fallback) return model;
  const resolved = await resolveProviderForModel(userId, model, { allowOfficialFallback: false });
  // No key can run it (a typo, a retired or unpriced model): the default
  // runs instead, as the editor promises, rather than the call failing. A
  // player's own endpoint (custom/, local/) is left to fail as before: they
  // chose not to run on our key, so we never start billing them for one.
  if (!resolved) return /^(custom|local)\//.test(model) ? model : fallback;
  if (resolved.isByok) return model;
  // Official resolutions carry the player's effective plan as their tier.
  const access = await validateModelAccess(resolved.apiKeyTier as PlanId, model);
  return access.allowed ? model : fallback;
}

/**
 * Why the player can't save `model` as a background model, or null when they
 * can. Same rule as planAllowedModel; used where the choice is saved, so the
 * player hears about it instead of the run quietly switching models.
 * `requiredPlan` lets the client say it in the player's language.
 */
export async function planBlockReason(userId: string, model: string): Promise<{ reason: string; requiredPlan?: string } | null> {
  const resolved = await resolveProviderForModel(userId, model, { allowOfficialFallback: false });
  if (!resolved || resolved.isByok) return null;
  const access = await validateModelAccess(resolved.apiKeyTier as PlanId, model);
  if (access.allowed) return null;
  return { reason: access.reason ?? "This model needs a higher plan.", requiredPlan: (await getModelPrice(model))?.minPlan };
}

/**
 * What an official-key call runs when the model it named is above the
 * player's plan: the player's own chat model if their plan covers it, else
 * `fallback`. Null when neither is allowed.
 */
export async function planFallbackModel(plan: PlanId, playerModel: string | undefined, fallback: string): Promise<string | null> {
  for (const candidate of [playerModel, fallback]) {
    if (!candidate || candidate.startsWith("local/") || candidate.startsWith("custom/")) continue;
    if ((await validateModelAccess(plan, candidate)).allowed) return candidate;
  }
  return null;
}

/**
 * The model a save is choosing, or null when it keeps the stored one (or
 * sends none). Saves resend the stored model with every edit, and only a new
 * choice is plan-checked, so a model saved before the check never blocks them.
 */
export function newModelChoice(
  sent: string | null | undefined,
  stored: string | null | undefined,
  normalize: (model: string) => string,
): string | null {
  if (!sent) return null;
  const model = normalize(sent);
  return stored && normalize(stored) === model ? null : model;
}
