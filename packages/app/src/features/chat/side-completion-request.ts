import type { AiGenerationConfig, ImageCompletionMessage } from "@yumina/shared";
import { kimiRepetitionOverride } from "@/lib/kimi-repetition";

export interface SideCompletionParams {
  messages: ImageCompletionMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  context?: "session";
  includeLorebook?: boolean | "all" | "matched";
  responseFormat?: { type: "json_object" };
}

type Preferences = Omit<AiGenerationConfig, "reasoningEffort" | "storyMemory"> & { reasoningEffort?: string };

/** Explicit allowlist: a sandbox posting its own `overrides` cannot replace
 * the parent's current player settings. Read config at the time of each call. */
export function buildSideCompletionRequest(params: SideCompletionParams, preferences: Preferences): SideCompletionParams & { overrides?: Preferences } {
  return {
    messages: params.messages,
    model: params.model,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    context: params.context,
    includeLorebook: params.includeLorebook,
    responseFormat: params.responseFormat,
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
      ...(preferences.repetitionPenalty !== undefined && kimiRepetitionOverride(params.model ?? "", preferences.repetitionPenalty)),
    } }),
  };
}
