import { resolveProviderForModel } from "../../lib/resolve-provider.js";
import { ensureWallet, validateModelAccess } from "../../lib/credit-service.js";
import { resolveEffectivePlanWithEventEntitlements } from "../../lib/event-plan-entitlements.js";
import { getModelContextWindow } from "../../lib/llm/context-window.js";
import { applyModelRedirect } from "../../lib/llm/model-redirects.js";
import { DEFAULT_STATE_GUARD_MODEL, parseStateGuardModel, stateGuardModelSelection } from "@yumina/shared";
import { edition } from "../../edition/index.js";

/** Imported hosted settings must not force a platform key in the BYOK edition. */
export function resolveGuardModelSelection(savedModel: string | null | undefined, storyModel: string, officialModels = edition.info().features.officialModels): string {
  if (officialModels) return savedModel ?? DEFAULT_STATE_GUARD_MODEL;
  const selection = parseStateGuardModel(savedModel);
  return stateGuardModelSelection(selection.model && selection.provider !== "official" ? selection.model : storyModel, "private");
}

/** Same credential routing as Memory, with chat's protected-card + plan gates. */
export async function resolveGuardModel(userId: string, modelId: string, forceOfficial: boolean) {
  const selection = parseStateGuardModel(modelId);
  const officialModels = edition.info().features.officialModels;
  if (!officialModels && (forceOfficial || selection.provider === "official")) throw new Error("Official models are unavailable in this edition. Choose your own API model.");
  if (forceOfficial && selection.provider === "private") throw new Error("This card does not allow private providers.");
  const model = applyModelRedirect(selection.model!);
  const resolved = await resolveProviderForModel(userId, model, {
    forceOfficial: forceOfficial || selection.provider === "official",
    forcePrivate: !officialModels || selection.provider === "private", allowOfficialFallback: false,
  });
  if (!resolved) throw new Error("The selected correction model has no available provider. Check AI Provider settings or choose another model.");
  if (!resolved.isByok) {
    const wallet = await ensureWallet(userId);
    const plan = await resolveEffectivePlanWithEventEntitlements(userId, wallet.plan);
    const access = await validateModelAccess(plan, model);
    if (!access.allowed) throw new Error("The selected correction model is not available on your plan.");
  }
  return { provider: resolved.provider, apiKeyTier: resolved.apiKeyTier, model, maxContext: Math.min(28_608, getModelContextWindow(model)) };
}
