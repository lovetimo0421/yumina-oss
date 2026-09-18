/** Compose the global selectedModel id from a profile + raw upstream model id.
 *  The chat uses prefix-based provider routing (custom/<id> → CustomProvider,
 *  openai/<id> → OpenAIProvider, etc.), so the prefix on `selectedModel` must
 *  match the active key's provider. OpenRouter is the exception — it doesn't
 *  use a prefix, since model ids already carry vendor info (e.g. anthropic/...). */
export function composeSelectedModelId(provider: string, rawModel: string): string {
  const trimmed = rawModel.trim();
  if (!trimmed) return "";
  if (provider === "custom") {
    return trimmed.startsWith("custom/") ? trimmed : `custom/${trimmed}`;
  }
  if (trimmed.includes("/")) return trimmed; // already prefixed
  if (provider === "openai") return `openai/${trimmed}`;
  if (provider === "anthropic") return `anthropic/${trimmed}`;
  if (provider === "google") return `google/${trimmed}`;
  if (provider === "ollama") return `ollama/${trimmed}`;
  return trimmed; // openrouter doesn't use a prefix
}
