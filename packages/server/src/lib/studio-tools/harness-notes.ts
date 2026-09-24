import type { ChatMessage } from "../llm/types.js";

/**
 * The only ways the agent loop may speak to the model in its own voice.
 *
 * A `role: "user"` message the creator didn't type is read as the creator's
 * newest turn. From 2026-09-17 a standing "[System: Work in small complete
 * steps…]" user message was appended after every iteration's tool results;
 * models answered it instead of the task ("you only sent a system prompt —
 * what do you need?"), and 165 runs from 35 creators ended that way in a week.
 *
 * So:
 * - Standing guidance belongs in the system prompt (see outputBudgetGuidance).
 * - Feedback about a tool call rides inside that call's result (withToolNote).
 * - A user turn is reserved for events with no tool result to carry them, and
 *   is only ever built here, from a fixed set of kinds (harnessTurn).
 */

/** Below this output cap a whole-file rewrite risks being cut off mid-JSON. */
export const SMALL_OUTPUT_BUDGET_TOKENS = 16000;

/** System-prompt text for a balance-shrunk output cap, or null when the cap is
 *  roomy enough that the model needs no warning. */
export function outputBudgetGuidance(maxTokens: number): string | null {
  if (maxTokens >= SMALL_OUTPUT_BUDGET_TOKENS) return null;
  return `The creator's balance limits this response to about ${maxTokens} output tokens, including any reasoning. Work in small complete steps: prefer targeted edits, and for a new UI feature connect a minimal usable component to the entry before adding polish. Finish each tool's JSON arguments within this response; do not start a whole-file rewrite that cannot fit.`;
}

const TURNS = {
  output_truncated: "[System: Your previous response was cut off by the output token limit before you could complete your tool call. Please continue — call the tool now without repeating your reasoning.]",
  text_only_reply: "[System: You replied with text but didn't call any tools. If you intended to create or change anything, call the tool now (write_entry, write_variable, write_behavior, write_custom_ui, edit_custom_ui, write_audio, update_settings, delete_entities) — don't just describe the change in prose. If you were only answering a question, or there is genuinely nothing to change, say so briefly and stop.]",
} as const;

export type HarnessTurnKind = keyof typeof TURNS;

/** A loop-authored user turn. Only for events that left no tool result: the
 *  model's reply was truncated, or it answered in prose without a tool call. */
export function harnessTurn(kind: HarnessTurnKind): ChatMessage {
  return { role: "user", content: TURNS[kind] };
}

export function isHarnessTurn(message: ChatMessage): boolean {
  return message.role === "user" && (Object.values(TURNS) as string[]).includes(message.content as string);
}

/** Attach loop feedback to the last tool result in `messages`. The note stays
 *  inside the JSON payload so providers that parse tool content (Gemini) keep
 *  the structured result. */
export function withToolNote(messages: ChatMessage[], note: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "tool") {
    // Never promote the note to a user turn; losing a nudge is harmless.
    console.warn("[Agent] withToolNote: no trailing tool result — note dropped");
    return messages;
  }
  let payload: unknown;
  try { payload = JSON.parse(last.content); } catch { payload = last.content; }
  const noted = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? { ...payload as Record<string, unknown>, studioNote: note }
    : { result: payload, studioNote: note };
  return [...messages.slice(0, -1), { ...last, content: JSON.stringify(noted) }];
}
