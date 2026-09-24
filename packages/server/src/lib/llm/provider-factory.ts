import type { LLMProvider } from "./types.js";
import type { ApiKeyMetadata } from "@yumina/shared";
import { OpenRouterProvider } from "./openrouter.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { GoogleProvider } from "./google.js";
import { CustomProvider } from "./custom.js";
import { LocalBridgeProvider } from "./local-bridge.js";

export type ProviderName = "openrouter" | "anthropic" | "openai" | "google" | "ollama" | "custom" | "local";

/** Create a provider instance. `baseUrl` and `metadata` are only consulted for `provider === "custom"`.
 *  For `provider === "local"` the first argument is the player's user id, not a key —
 *  the model runs on their machine and there is nothing to authenticate against. */
export function createProvider(
  provider: ProviderName,
  apiKeyOrUrl: string,
  baseUrl?: string,
  metadata?: ApiKeyMetadata | null,
): LLMProvider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(apiKeyOrUrl);
    case "openai":
      return new OpenAIProvider(apiKeyOrUrl);
    case "google":
      return new GoogleProvider(apiKeyOrUrl);
    case "ollama":
      return new OllamaProvider(apiKeyOrUrl);
    case "local":
      return new LocalBridgeProvider(apiKeyOrUrl);
    case "custom":
      if (!baseUrl) {
        throw new Error("createProvider: custom provider requires baseUrl");
      }
      return new CustomProvider(apiKeyOrUrl, baseUrl, metadata ?? null);
    case "openrouter":
    default:
      return new OpenRouterProvider(apiKeyOrUrl);
  }
}

/** Create a provider backed by a user-owned key. OpenRouter BYOK accounts may
 * configure their own upstream/provider routing, which request-level routing
 * must not override. */
export function createByokProvider(
  provider: ProviderName,
  apiKeyOrUrl: string,
  baseUrl?: string,
  metadata?: ApiKeyMetadata | null,
): LLMProvider {
  if (provider === "openrouter") {
    return new OpenRouterProvider(apiKeyOrUrl, { preserveAccountRouting: true });
  }
  return createProvider(provider, apiKeyOrUrl, baseUrl, metadata);
}

/** Infer provider from model ID prefix. */
export function inferProvider(modelId: string): ProviderName {
  if (modelId.startsWith("local/")) return "local";
  if (modelId.startsWith("custom/")) return "custom";
  if (modelId.startsWith("anthropic/")) return "anthropic";
  if (modelId.startsWith("openai/")) return "openai";
  if (modelId.startsWith("google/")) return "google";
  if (modelId.startsWith("ollama/")) return "ollama";
  return "openrouter";
}
