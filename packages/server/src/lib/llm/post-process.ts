import type { ChatMessage, MessageContent } from "./types.js";
import type { PromptPostProcessing } from "@yumina/shared";

/**
 * Apply a SillyTavern-style prompt post-processing strategy to a message list.
 * The transforms are intentionally non-destructive of *content* — they only
 * change the *role sequence* by merging or relabeling adjacent messages so the
 * upstream model (Claude, etc.) accepts the request.
 *
 * The transforms operate on engine-shaped ChatMessage objects (string content
 * is the common case; ContentPart[] is preserved by joining the text parts).
 */
export function applyPromptPostProcessing(
  messages: ChatMessage[],
  mode: PromptPostProcessing | undefined,
): ChatMessage[] {
  if (!mode || mode === "none") return messages;
  if (mode === "single") return collapseToSingleUser(messages);

  const keepTools = mode === "merge_tools" || mode === "semi_tools" || mode === "strict_tools";
  const merged = mergeAdjacentSameRole(messages, keepTools);

  if (mode === "merge" || mode === "merge_tools") return merged;
  if (mode === "semi" || mode === "semi_tools") return enforceAlternation(merged, { allowLeadingSystem: true, keepTools });
  // strict / strict_tools
  return enforceAlternation(merged, { allowLeadingSystem: false, keepTools });
}

/** Concatenate message content into a single string, ignoring image parts. */
function flattenContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Walk messages; merge runs of same-role messages into one. Tool messages are left alone if `keepTools`. */
function mergeAdjacentSameRole(messages: ChatMessage[], keepTools: boolean): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool" && keepTools) {
      out.push(m);
      continue;
    }
    // Assistant messages with tool_calls are not safe to merge — they have semantic structure.
    if (m.role === "assistant" && "tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) {
      out.push(m);
      continue;
    }

    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && prev.role !== "tool" && !("tool_calls" in prev && prev.tool_calls && prev.tool_calls.length > 0)) {
      const prevText = flattenContent(prev.content);
      const nextText = flattenContent(m.content);
      const joined = prevText && nextText ? `${prevText}\n\n${nextText}` : prevText || nextText;
      out[out.length - 1] = { role: prev.role, content: joined } as ChatMessage;
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Enforce user/assistant alternation. Optionally allows a single leading system message. */
function enforceAlternation(
  messages: ChatMessage[],
  opts: { allowLeadingSystem: boolean; keepTools: boolean },
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let systemPrefix = "";

  for (const m of messages) {
    if (m.role === "system") {
      const text = flattenContent(m.content);
      systemPrefix = systemPrefix ? `${systemPrefix}\n\n${text}` : text;
      continue;
    }
    if (m.role === "tool" && opts.keepTools) {
      out.push(m);
      continue;
    }
    if (m.role === "tool" && !opts.keepTools) {
      // Convert tool result into a user message describing it
      out.push({ role: "user", content: `[tool_result] ${flattenContent(m.content)}` });
      continue;
    }
    if (m.role === "user" || m.role === "assistant") {
      out.push(m);
    }
  }

  if (systemPrefix) {
    if (opts.allowLeadingSystem) {
      out.unshift({ role: "system", content: systemPrefix });
    } else {
      // Fold system into the first user message (Claude-strict style)
      const firstUserIdx = out.findIndex((m) => m.role === "user");
      if (firstUserIdx >= 0) {
        const target = out[firstUserIdx]!;
        const targetText = flattenContent(target.content);
        out[firstUserIdx] = { role: "user", content: `${systemPrefix}\n\n${targetText}` };
      } else {
        out.unshift({ role: "user", content: systemPrefix });
      }
    }
  }

  // Final pass: collapse any remaining same-role runs that survived the conversions above.
  return mergeAdjacentSameRole(out, opts.keepTools);
}

/** Collapse the entire conversation into one user message — useful for completion-only endpoints. */
function collapseToSingleUser(messages: ChatMessage[]): ChatMessage[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      lines.push(`[system]\n${flattenContent(m.content)}`);
    } else if (m.role === "user") {
      lines.push(`[user]\n${flattenContent(m.content)}`);
    } else if (m.role === "assistant") {
      lines.push(`[assistant]\n${flattenContent(m.content)}`);
    } else if (m.role === "tool") {
      lines.push(`[tool_result]\n${flattenContent(m.content)}`);
    }
  }
  return [{ role: "user", content: lines.join("\n\n") }];
}
