import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { decryptApiKey } from "./crypto.js";
import { createByokProvider, createProvider, inferProvider } from "./llm/provider-factory.js";
import type { ProviderName } from "./llm/provider-factory.js";
import type { LLMProvider } from "./llm/types.js";
import type { ApiKeyMetadata } from "@yumina/shared";
import { RETIRED_PLAY_MODEL_IDS } from "@yumina/shared";
import { isOfficialModel } from "./model-price-cache.js";
import { ensureWallet } from "./credit-service.js";
import { resolveEffectivePlanWithEventEntitlements } from "./event-plan-entitlements.js";
import { env } from "./env.js";
import { allowsOfficialKeyFallback } from "./provider-selection-policy.js";

export type ApiKeyTier = "regular" | "invited" | "byok";

export interface ResolvedProvider {
  provider: LLMProvider;
  providerName: ProviderName;
  isByok: boolean;
  apiKeyTier: ApiKeyTier;
}

/** Decrypt a user's stored API key for a given provider, preferring the active profile.
 *  Falls back to the most recently created key matching the provider. */
export async function getUserApiKey(
  userId: string,
  provider = "openrouter"
): Promise<string | null> {
  const activeId = await getActiveApiKeyId(userId);

  if (activeId) {
    const [active] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, activeId), eq(apiKeys.userId, userId), eq(apiKeys.provider, provider)));
    if (active) {
      const key = sanitizeDecrypted(decryptApiKey(active.encryptedKey, active.keyIv, active.keyTag));
      if (key) return key;
      // Corrupted / empty key — fall through to try other rows
    }
  }

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, provider)))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  return sanitizeDecrypted(decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag));
}

/** Treat empty / whitespace-only / "null" plaintext as a missing key.
 *  Past incident: a user (kljws) had an openrouter row whose ciphertext was
 *  half the length of a real `sk-or-v1-…` key — decryption succeeded but
 *  produced a value that, when sent as `Authorization: Bearer <value>`,
 *  caused OpenRouter to return 401 "Missing Authentication header". Treating
 *  these as null lets `resolveProviderForModel` fall through cleanly to the
 *  official key path instead of forwarding a junk token. */
function sanitizeDecrypted(key: string | null): string | null {
  if (key === null) return null;
  const trimmed = key.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined") return null;
  return key;
}

/** Fetch the active (or most recent) custom-key row, including metadata. */
async function getUserCustomKey(
  userId: string
): Promise<{ apiKey: string; baseUrl: string; metadata: ApiKeyMetadata | null } | null> {
  const activeId = await getActiveApiKeyId(userId);

  let row: typeof apiKeys.$inferSelect | undefined;

  if (activeId) {
    const [active] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, activeId), eq(apiKeys.userId, userId), eq(apiKeys.provider, "custom")));
    row = active;
  }

  if (!row) {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, "custom")))
      .orderBy(desc(apiKeys.createdAt))
      .limit(1);
    row = rows[0];
  }

  if (!row) return null;
  if (!row.baseUrl) return null; // misconfigured row — treat as absent
  const apiKey = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
  if (!apiKey) return null; // corrupted key data
  return {
    apiKey,
    baseUrl: row.baseUrl,
    metadata: (row.metadata as ApiKeyMetadata | null) ?? null,
  };
}

/** Get user's plan (from wallet — single source of truth) and preferred provider. */
async function getUserMeta(userId: string): Promise<{
  plan: string;
  preferredProvider: "official" | "private";
}> {
  const [row] = await db
    .select({ preferences: user.preferences })
    .from(user)
    .where(eq(user.id, userId));

  // Wallet is the authoritative source for plan — never read user.tier for this.
  const wallet = await ensureWallet(userId);
  const effectivePlan = await resolveEffectivePlanWithEventEntitlements(userId, wallet.plan);

  const prefs = row?.preferences as Record<string, unknown> | null;
  return {
    plan: effectivePlan,
    preferredProvider:
      prefs?.preferredProvider === "private" ? "private" : "official",
  };
}

/** Read user.preferences.activeApiKeyId — the user-selected "active" connection profile. */
async function getActiveApiKeyId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferences: user.preferences })
    .from(user)
    .where(eq(user.id, userId));
  const prefs = row?.preferences as Record<string, unknown> | null;
  const id = prefs?.activeApiKeyId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Resolve provider and API key for a model.
 *
 * Default: all users use the official Yumina API ("official").
 * Users who explicitly toggle to "Private Key" get BYOK priority.
 *
 * When preferredProvider === "official" (default):
 *   1. Official key (tier-based: invited → regular)
 *   2. null
 *
 * When preferredProvider === "private":
 *   1. BYOK key → isByok=true (active profile honored if set)
 *   2. null (official fallback requires an explicit opt-in)
 */
export async function resolveProviderForModel(
  userId: string,
  modelId: string,
  options?: {
    forceOfficial?: boolean;
    /** Explicit extension selection; never changes the account preference. */
    forcePrivate?: boolean;
    allowNonPriced?: boolean;
    /** Chat callers must reject these models before inference. Allows a saved
     * retired selection to reach the unavailable-model error, not a key error. */
    allowRetiredForAccessCheck?: boolean;
    /** Explicitly permit a private-mode request to use Yumina's official key
     * when no user key is available. Defaults to false so BYOK fails closed. */
    allowOfficialFallback?: boolean;
  }
): Promise<ResolvedProvider | null> {
  const providerName = inferProvider(modelId);
  const meta = await getUserMeta(userId);
  const { plan } = meta;
  const preferredProvider = options?.forcePrivate ? "private" : meta.preferredProvider;
  const retiredAccessCheck = options?.allowRetiredForAccessCheck && RETIRED_PLAY_MODEL_IDS.has(modelId);

  // Force official keys (e.g., protected worlds with allowEdit=false)
  // Skip BYOK entirely — user's own key must never see the prompt data
  if (options?.forceOfficial) {
    // Custom models can never run under official mode (no pricing/billing info)
    if (providerName === "custom") return null;
    // Nor can a local one: forceOfficial exists to keep a protected world's
    // hidden prompt off machines we don't control, and "the player's own PC"
    // is the most uncontrolled of them.
    if (providerName === "local") return null;
    if (!retiredAccessCheck && !(await isOfficialModel(modelId))) {
      return null;
    }
    const officialKey = resolveOfficialKey(plan);
    if (officialKey) {
      return { provider: createProvider("openrouter", officialKey), providerName: "openrouter" as ProviderName, isByok: false, apiKeyTier: plan as ApiKeyTier };
    }
    return null;
  }

  // A local model has no key to resolve — it runs on the player's own machine,
  // reached through their browser, and costs us nothing. Treated as BYOK so the
  // credit, rate-limit and concurrency gates skip it for the same reason they
  // skip a player's own API key. Unreachable under forceOfficial (handled above).
  if (providerName === "local") {
    return {
      provider: createProvider("local", userId),
      providerName: "local" as ProviderName,
      isByok: true,
      apiKeyTier: "byok",
    };
  }

  // Private mode: try BYOK first
  if (preferredProvider === "private") {
    if (providerName === "custom") {
      const custom = await getUserCustomKey(userId);
      if (custom) {
        return {
          provider: createByokProvider("custom", custom.apiKey, custom.baseUrl, custom.metadata),
          providerName: "custom" as ProviderName,
          isByok: true,
          apiKeyTier: "byok",
        };
      }
      // No custom key configured — do NOT fall back to OpenRouter for custom/* models
      return null;
    }
    const apiKey = await getUserApiKey(userId, providerName);
    if (apiKey) {
      return { provider: createByokProvider(providerName, apiKey), providerName, isByok: true, apiKeyTier: "byok" };
    }
    if (providerName !== "openrouter") {
      const orKey = await getUserApiKey(userId, "openrouter");
      if (orKey) {
        return { provider: createByokProvider("openrouter", orKey), providerName: "openrouter" as ProviderName, isByok: true, apiKeyTier: "byok" };
      }
    }
    if (options?.forcePrivate) return null;
    if (!allowsOfficialKeyFallback(preferredProvider, options?.allowOfficialFallback)) return null;
    // Fall through to official keys
  }

  // Official keys — only models in the model_prices table can use official keys.
  // allowNonPriced: studio has its own allowlist and may use models not in model_prices.
  if (!retiredAccessCheck && !options?.allowNonPriced && !(await isOfficialModel(modelId))) {
    return null;
  }

  const officialKey = resolveOfficialKey(plan);
  if (officialKey) {
    return { provider: createProvider("openrouter", officialKey), providerName: "openrouter" as ProviderName, isByok: false, apiKeyTier: plan as ApiKeyTier };
  }

  // No official key configured — last resort: try BYOK even in official mode
  if (preferredProvider === "official") {
    if (providerName === "custom") {
      const custom = await getUserCustomKey(userId);
      if (custom) {
        return {
          provider: createByokProvider("custom", custom.apiKey, custom.baseUrl, custom.metadata),
          providerName: "custom" as ProviderName,
          isByok: true,
          apiKeyTier: "byok",
        };
      }
      return null;
    }
    const apiKey = await getUserApiKey(userId, providerName);
    if (apiKey) {
      return { provider: createByokProvider(providerName, apiKey), providerName, isByok: true, apiKeyTier: "byok" };
    }
    if (providerName !== "openrouter") {
      const orKey = await getUserApiKey(userId, "openrouter");
      if (orKey) {
        return { provider: createByokProvider("openrouter", orKey), providerName: "openrouter" as ProviderName, isByok: true, apiKeyTier: "byok" };
      }
    }
  }

  return null;
}

/** Pick the right official OpenRouter key. Non-free users get the invite key if available. */
function resolveOfficialKey(plan: string): string | null {
  // Any plan above free (go, plus, pro, ultra, internal) gets the invite key
  if (plan !== "free" && plan !== "regular" && env.YUMINA_INVITE_OPENROUTER_KEY) {
    return env.YUMINA_INVITE_OPENROUTER_KEY;
  }
  return env.YUMINA_OPENROUTER_KEY || null;
}

/**
 * The OpenRouter key a side call (music generation) should use for this user.
 * Mirrors resolveProviderForModel: private-mode BYOK first, then the official
 * key for the user's plan, then BYOK as the no-official-key fallback.
 */
export async function resolveOpenRouterKeyForUser(userId: string): Promise<{
  apiKey: string;
  isByok: boolean;
  apiKeyTier: ApiKeyTier;
} | null> {
  const { plan, preferredProvider } = await getUserMeta(userId);

  if (preferredProvider === "private") {
    const byok = await getUserApiKey(userId, "openrouter");
    if (byok) return { apiKey: byok, isByok: true, apiKeyTier: "byok" };
  }

  const officialKey = resolveOfficialKey(plan);
  if (officialKey) {
    return { apiKey: officialKey, isByok: false, apiKeyTier: plan as ApiKeyTier };
  }

  const byok = await getUserApiKey(userId, "openrouter");
  if (byok) return { apiKey: byok, isByok: true, apiKeyTier: "byok" };
  return null;
}
