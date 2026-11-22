/**
 * The state slice the chat's background resolver reads.
 *
 * `useChatStore().gameState` is only the variables map. The opening being
 * played (`activeGreetingId`) and the AI's `[bg: …]` pick (`metadata.currentBg`)
 * live on the session's full state. Resolving from `gameState` alone made every
 * background scoped to an opening disappear in play while the Studio preview
 * showed it (11/08, a creator's card with all its backgrounds tied to openings
 * played on a black screen), and an AI-picked background never showed.
 *
 * Variables come from `gameState`, because a card's optimistic writes land
 * there first.
 */
export interface ChatBackgroundState {
  variables: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  activeGreetingId: string | null;
}

export function chatBackgroundState(
  sessionState: unknown,
  liveVariables: Record<string, unknown> | null | undefined,
): ChatBackgroundState {
  const full = (sessionState && typeof sessionState === "object" ? sessionState : {}) as {
    variables?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    activeGreetingId?: unknown;
  };
  return {
    variables: liveVariables ?? full.variables ?? {},
    metadata: full.metadata,
    activeGreetingId: typeof full.activeGreetingId === "string" && full.activeGreetingId ? full.activeGreetingId : null,
  };
}
