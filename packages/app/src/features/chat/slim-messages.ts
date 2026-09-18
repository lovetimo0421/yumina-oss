/**
 * Slim the messages array before it is structured-cloned across the sandbox
 * bridge into the iframe (WorldRenderer's "messages" channel).
 *
 * The iframe only ever renders the ACTIVE swipe of each message:
 *   - swiping is server-mediated (api.swipeMessage refetches the content), so
 *     non-active swipes' `content`/`rawContent` are never displayed — only the
 *     swipe COUNT (array length) + activeSwipeIndex drive the "N/M" control
 *     (see sandbox/chat/swipe-controls.tsx).
 *   - the "view raw" drawer reads ONLY the active swipe's `rawContent`
 *     (see sandbox/chat/message-bubble.tsx).
 *   - the iframe reads the MESSAGE-level `stateSnapshot` for per-message
 *     variables (messageVars / custom renderers), never the SWIPE-level one
 *     (that exists for server-side swipe restore).
 *
 * So for the pushed copy only — the full array stays in the Zustand store — we
 * drop: swipe-level `stateSnapshot` on every swipe, plus `content`+`rawContent`
 * on NON-active swipes. Message-level `stateSnapshot` and the active swipe's
 * content/rawContent are KEPT. This shrinks the structured-clone, the retained
 * memory (the payload is otherwise held ~3x), and the per-keystroke cost a
 * custom card pays iterating the array — without changing anything that renders.
 *
 * Pure + side-effect free so it can be memoized on `api.messages` and unit
 * tested. Returns the input array unchanged (same ref) when nothing was
 * stripped, so memoization stays stable for swipe-free chats.
 */
type Msg = Record<string, unknown>;

export function slimMessages(messages: ReadonlyArray<Msg>): Msg[] {
  let changed = false;
  const out = messages.map((m) => {
    const swipes = m.swipes;
    if (!Array.isArray(swipes) || swipes.length === 0) return m;
    const activeIdx =
      typeof m.activeSwipeIndex === "number" ? m.activeSwipeIndex : 0;
    const slimSwipes = swipes.map((s, i) => {
      if (s == null || typeof s !== "object") return s;
      // Drop swipe-level stateSnapshot for every swipe.
      const { stateSnapshot: _drop, ...rest } = s as Msg;
      if (i === activeIdx) return rest; // active swipe keeps content + rawContent
      // Non-active swipe: drop the big display strings too (not rendered).
      const { content: _c, rawContent: _r, ...scalars } = rest;
      return scalars;
    });
    changed = true;
    return { ...m, swipes: slimSwipes };
  });
  return changed ? out : (messages as Msg[]);
}
