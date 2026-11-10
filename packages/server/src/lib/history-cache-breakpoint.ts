/**
 * Second cache breakpoint of a chat turn. The caller's offset estimate assumes
 * ONE message sits at the deepest keyword depth, but every keyword entry that
 * fires lands there, so with two or more the estimate fell inside the entry
 * block. That block moves down two messages a turn and changes with whatever
 * fired, so the cached prefix never matched the next turn (local replay:
 * broken on 12 of 13 turns). OpenRouter's Gemini caching uses only the last
 * breakpoint, so this one decides Gemini's hits outright. Breaking just before
 * the first injected entry that survived trimming keeps the cached prefix pure
 * conversation, which the next turn repeats verbatim.
 */
export function historyCacheBreakpoint<T>(
  chatMessages: readonly T[],
  injected: ReadonlySet<T>,
  offsetIndex: number,
): number {
  const firstInjected = chatMessages.findIndex((m) => injected.has(m));
  return firstInjected < 0 ? offsetIndex : Math.min(offsetIndex, firstInjected - 1);
}
