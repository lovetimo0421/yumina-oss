import type { AiGenerationConfig, CompletionResponseFormat, ImageCompletionMessage, SideCompletionWorldbookIds } from "@yumina/shared";
import { kimiRepetitionOverride } from "@/lib/kimi-repetition";

export interface SideCompletionParams {
  messages: ImageCompletionMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  context?: "session";
  includeLorebook?: boolean | "all" | "matched";
  worldbookIds?: SideCompletionWorldbookIds;
  responseFormat?: CompletionResponseFormat;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
}

type Preferences = Omit<AiGenerationConfig, "reasoningEffort" | "storyMemory" | "recapShare" | "memoryEvery"> & { reasoningEffort?: string; selectedModel?: string };

/** Explicit allowlist: a sandbox posting its own `overrides` cannot replace
 * the parent's current player settings. Read config at the time of each call. */
export function buildSideCompletionRequest(params: SideCompletionParams, preferences: Preferences): SideCompletionParams & { overrides?: Preferences; modelSource?: "card" } {
  // A call that names no model runs on the player's own story model, not a
  // server default (which once was Sonnet).
  const model = params.model || preferences.selectedModel || undefined;
  return {
    messages: params.messages,
    model,
    // A model the card's code named itself (not the player's own pick) falls
    // back on the server when the player's plan can't run it.
    ...(params.model && params.model !== preferences.selectedModel && { modelSource: "card" as const }),
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    context: params.context,
    includeLorebook: params.includeLorebook,
    worldbookIds: params.worldbookIds,
    responseFormat: params.responseFormat,
    reasoningEffort: params.reasoningEffort,
    ...(params.context === "session" && { overrides: {
      maxTokens: preferences.maxTokens,
      maxContext: preferences.maxContext,
      temperature: preferences.temperature,
      topP: preferences.topP,
      frequencyPenalty: preferences.frequencyPenalty,
      presencePenalty: preferences.presencePenalty,
      topK: preferences.topK,
      minP: preferences.minP,
      reasoningEffort: preferences.reasoningEffort,
      streaming: preferences.streaming,
      ...(preferences.repetitionPenalty !== undefined && kimiRepetitionOverride(model ?? "", preferences.repetitionPenalty)),
    } }),
  };
}
