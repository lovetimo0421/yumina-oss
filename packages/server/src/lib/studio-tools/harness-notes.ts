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
  advise_go_ahead: "[System: The creator agreed to build. Discussion mode cannot change the card: call save_brief now with what was agreed as the steps (a small fix is one step), so they can start it with one press. Do not say you are building.]",
  text_only_reply: "[System: You replied with text but didn't call any tools. If you intended to create or change anything, call the tool now (write_entry, write_variable, write_behavior, write_custom_ui, edit_custom_ui, write_audio, update_settings, delete_entities) — don't just describe the change in prose. If you were only answering a question, or there is genuinely nothing to change, say so briefly and stop.]",
} as const;

export type HarnessTurnKind = keyof typeof TURNS;

/** A loop-authored user turn. Only for events that left no tool result: the
 *  model's reply was truncated, or it answered in prose without a tool call. */
export function harnessTurn(kind: HarnessTurnKind): ChatMessage {
  return { role: "user", content: TURNS[kind] };
}

// Phrases that announce an action the reply then never took ("现在直接修复——把",
// "Let me update the entry"). Checked against the reply's ending, where a
// stalled plan trails off; an answer that merely opens with "Let me explain"
// is not a stall.
const ACTION_INTENT = /我来|我会|我将|我现在|现在(?:就|直接|开始|来|去)?(?:修|改|加|写|做|创建|添加|删除|更新|调整|处理|实现)|接下来|下面我|马上|开始(?:修|改|写|做|创建|添加)|\bI'll\b|\bI will\b|\bI'm going to\b|\bLet me\b|\bNow I\b|\bNext,? I\b/i;
const ACTION_INTENT_TAIL_CHARS = 300;

/** Whether a text-only reply reads as "about to act" rather than a finished
 *  answer. Only such replies earn the text_only_reply nudge — a pure Q&A
 *  answer used to be nudged (twice), costing extra calls and bubbles. */
export function replyAnnouncesAction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return ACTION_INTENT.test(trimmed.slice(-ACTION_INTENT_TAIL_CHARS));
}

// A short reply that agrees to go ahead: "Yes", "Proceed", "开始搭建", "做吧".
// In Advise, 61 of 151 such replies stayed in discussion, often after the
// advisor itself offered a change ("Here's what I need to add — proceed?").
const GO_AHEAD = /^(yes|yep|yeah|ok(ay)?|sure|proceed|go( ahead)?|do it|build( it| the rest)?|start( building)?|let'?s (go|do it|build)|好(的|啊|吧)?|可以|行|做吧|开始(搭建|做|吧)?|开工|搭(吧|建)|继续|就这样|没问题|是的?|はい|お願い|sí|dale|adelante)[\s!！.。,，~]*$/i;

/** Whether the creator's message is a bare go-ahead, not a new request. */
export function isGoAhead(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 30 && GO_AHEAD.test(trimmed);
}

// The advisor's own offer to act, at the end of its reply: what a bare "yes"
// would be agreeing to. Without one, "好" is just an answer to a question.
const OFFER = /proceed|shall i|should i|want me to|ready to (build|start)|start building|build (it|this|the)|go ahead|let me (add|fix|build|make)|要我|需要我|我来|开始搭建|开工|动手|可以开始|这样改|改吗|做吗|加吗|搭建|Start building|開始|empez|constru/i;

/** Whether an assistant reply ends by offering to make a change now. */
export function offersToAct(text: string): boolean {
  return OFFER.test(text.trim().slice(-400));
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
