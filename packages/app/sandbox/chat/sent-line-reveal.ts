/**
 * Keeps a reply visible in a card's short messages box.
 *
 * The platform list does not follow a streaming reply: in a full-height chat
 * the reply starts in view and the reader decides when to scroll. A card can
 * instead drop the list into a short fixed box (the example template's is
 * ~230px). There, scrolling to the bottom on send parks the player's line on
 * the bottom edge and the whole reply grows out of sight, so the playtest
 * looks like it never answered.
 *
 * In a short box the sent line is walked up to the top edge instead. It cannot
 * get there on send, because nothing is below it yet, so each step moves it as
 * far as the content allows. The walk ends once the line reaches the top, so
 * the rest of the reply is left to the reader, as it is in the full chat.
 */

/** Gap left above the sent line, so it reads as the start of a turn. */
const TOP_GAP_PX = 8;

/** A box under half the frame is a card's embedded transcript, not the chat. */
export function isShortTranscript(viewport: HTMLElement): boolean {
  const frameHeight = viewport.ownerDocument.defaultView?.innerHeight ?? 0;
  return frameHeight > 0 && viewport.clientHeight > 0 && viewport.clientHeight < frameHeight / 2;
}

/** The newest line the player sent: the one a reply is about to grow under. */
export function lastSentLineId(messages: ReadonlyArray<{ id: string; role: string }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.id;
  }
  return null;
}

/**
 * Move the viewport toward putting `row` at its top. Never scrolls up, so it
 * cannot fight a reader. Returns true once the row can sit at the top.
 */
export function revealSentLineStep(
  viewport: HTMLElement,
  row: HTMLElement,
  setTop: (element: HTMLElement, top: number) => void,
): boolean {
  const box = viewport.getBoundingClientRect();
  // Card stages scale the whole transcript with a CSS transform: rects come
  // back in screen pixels, scrollTop is in the box's own. Convert, or a 0.7x
  // stage stops the line a third of the way short.
  const scale = viewport.offsetHeight > 0 && box.height > 0 ? box.height / viewport.offsetHeight : 1;
  const target = (row.getBoundingClientRect().top - box.top) / scale
    + viewport.scrollTop - TOP_GAP_PX;
  const max = viewport.scrollHeight - viewport.clientHeight;
  const next = Math.min(target, max);
  if (next > viewport.scrollTop + 0.5) setTop(viewport, next);
  return max >= target;
}
