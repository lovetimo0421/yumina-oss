import type { ToolResult } from "./index.js";
import type { ToolResultMessage } from "../llm/types.js";

/**
 * Serialize tool execution results into `tool` role messages — exactly ONE
 * message per tool_call_id, in first-seen order.
 *
 * Anthropic (via OpenRouter) rejects a turn where a single tool_use id has more
 * than one tool_result block:
 *   "messages.N.content.M: each tool_use must have a single result.
 *    Found multiple `tool_result` blocks."
 * This is the #1 source of Studio 400s. It happens because one write tool call
 * can expand into multiple schema changes — `delete_entities({ ids: [a, b, c] })`
 * yields one ParsedToolCall (hence one ToolResult) per id, all carrying the
 * originating call's id (see toolCallsToSchemaChanges). The old code mapped each
 * ToolResult to its own `tool` message, producing duplicate ids for one tool_use.
 *
 * Results sharing an id are merged into a single message whose content is the
 * JSON array of their payloads. A lone result keeps its exact prior
 * serialization (`result ?? { error }`), so single-result turns are
 * byte-identical to the previous behavior.
 */
export function buildToolResultMessages(results: ToolResult[]): ToolResultMessage[] {
  const order: string[] = [];
  const byId = new Map<string, ToolResult[]>();
  for (const r of results) {
    const group = byId.get(r.tool_call_id);
    if (group) {
      group.push(r);
    } else {
      byId.set(r.tool_call_id, [r]);
      order.push(r.tool_call_id);
    }
  }

  return order.map((id): ToolResultMessage => {
    const group = byId.get(id)!;
    const payload =
      group.length === 1
        ? group[0]!.result ?? { error: group[0]!.error }
        : group.map((r) => r.result ?? { error: r.error });
    return { role: "tool", tool_call_id: id, content: JSON.stringify(payload) };
  });
}
