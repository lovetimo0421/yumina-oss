import type { StudioChatMessage } from "./types";

export type StudioHistoryScope = {
  worldId: string | null;
  conversationId: string | null;
};

export function shouldReuseStudioHistory(current: StudioHistoryScope, requested: StudioHistoryScope): boolean {
  return (
    current.worldId !== null &&
    requested.worldId !== null &&
    current.worldId === requested.worldId &&
    current.conversationId === requested.conversationId
  );
}

export function shouldAcceptStudioChatScope(
  current: StudioHistoryScope,
  requested: StudioHistoryScope,
  messageCount: number,
): boolean {
  return (
    shouldReuseStudioHistory(current, requested) ||
    (
      current.worldId === null &&
      current.conversationId === null &&
      messageCount === 0
    )
  );
}

export function selectScopedStudioHistory(
  messages: StudioChatMessage[],
  current: StudioHistoryScope,
  requested: StudioHistoryScope,
  limit = 40,
): StudioChatMessage[] {
  if (!shouldReuseStudioHistory(current, requested)) return [];
  return messages.slice(-limit);
}
