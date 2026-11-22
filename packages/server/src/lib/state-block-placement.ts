/**
 * Where a chat turn puts the per-turn state block (PromptBuilder.buildFormatBlock:
 * <game-state>, <last-turn-changes>, <state-reminder>).
 *
 * Default: its own system message right after the conversation, for recency
 * (dd0672d41). Some model families largely ignore a system message that
 * arrives after the conversation and then rarely write state directives. For
 * them the block is appended to the player's final message instead. 11/21
 * offline probe, 3 real cards x 7 models x 15 turns: DeepSeek V3.2 wrote
 * directives on 60-67% of turns instead of 33%, V4.1 Flash 13-20% instead of
 * 0%, with no state text leaking into prose and no malformed output.
 * Claude, Gemini and everyone else read late system messages fine and keep
 * the default. Nothing else moves: the static format block, lore,
 * post-history entries, notes and the output contract stay where they are.
 */
const STATE_BLOCK_IN_PLAYER_TURN: ReadonlyArray<{ openRouterPrefix: string; customName: string }> = [
  { openRouterPrefix: "deepseek/", customName: "deepseek" },
  { openRouterPrefix: "xiaomi/mimo", customName: "mimo" },
  { openRouterPrefix: "z-ai/glm", customName: "glm" },
];

/** True when this model gets the state block inside the player's final message. */
export function stateBlockGoesInPlayerTurn(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.startsWith("custom/")) {
    // A custom (BYOK) endpoint names models however it likes: "deepseek-chat",
    // "deepseek-ai/DeepSeek-V3.2", "zai-org/GLM-4.6", "Pro/deepseek-ai/…".
    const segments = id.slice("custom/".length).split("/");
    return STATE_BLOCK_IN_PLAYER_TURN.some(({ customName }) => segments.some((s) => s.startsWith(customName)));
  }
  return STATE_BLOCK_IN_PLAYER_TURN.some(({ openRouterPrefix }) => id.startsWith(openRouterPrefix));
}

/** Between the player's words and the block (the block keeps its own tags). */
export const STATE_BLOCK_SEPARATOR = "\n\n";

/**
 * For a model in the list above, append `block` to the player's final message
 * in this prompt and return that message; the caller then skips the separate
 * system message. Returns null — caller keeps the system message — for every
 * other model, and when the conversation does not end on a player message
 * (continue ends on the assistant's partial reply).
 *
 * `history` is the prompt's own copy of the conversation (built from the
 * stored rows), so the stored messages never see the block. Depth-injected
 * lore that sits after the player's message is stepped over. Images are
 * attached later by restoreChatImages from `sourceMessageId`, as a text part
 * followed by image parts, so the block rides in that text part.
 */
export function foldStateBlockIntoPlayerTurn<M extends { role: string; content: string; sourceMessageId?: string }>(
  model: string,
  block: string,
  history: readonly M[],
  injected: ReadonlySet<M>,
): M | null {
  if (!block || !stateBlockGoesInPlayerTurn(model)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (injected.has(message)) continue;
    if (message.role !== "user" || !message.sourceMessageId) return null;
    message.content = message.content ? `${message.content}${STATE_BLOCK_SEPARATOR}${block}` : block;
    return message;
  }
  return null;
}
