/**
 * Keeps a new reply in view in the full-height chat.
 *
 * The list used to scroll only on send: it parked at the bottom with the
 * player's own line, the reply then grew below the fold, and when it
 * finished only its speaker label peeked in (launch QA, desktop long replies
 * and every phone). Now, while the reader has not scrolled away, the list
 * follows the reply as it grows — but never past the reply's first line: a
 * reply taller than the screen stops with its start at the top, where the
 * reader begins reading. Like the short-box walk (sent-line-reveal.ts) it only
 * ever scrolls down, so it cannot fight a reader.
 */

/** Gap kept above the reply so its speaker label stays in view. */
const REPLY_TOP_GAP_PX = 12;

/**
 * Scroll toward showing as much of `reply` as fits, its start included.
 *
 * `settle` is for the frames right after the reply finished: the streaming
 * bubble is swapped for the saved row, and Chrome's scroll anchoring can
 * throw the viewport to the very bottom in that swap (seen on a 390px phone:
 * a 24-paragraph reply ended with its first line 1600px above the screen).
 * While settling — and only until the reader touches anything — the step may
 * also move up, back to the reply's start.
 */
export function followReplyStep(
  viewport: HTMLElement,
  reply: HTMLElement,
  setTop: (element: HTMLElement, top: number) => void,
  settle = false,
): void {
  const box = viewport.getBoundingClientRect();
  // Card stages can scale the transcript with a transform (see
  // sent-line-reveal.ts): convert screen pixels into the box's own.
  const scale = viewport.offsetHeight > 0 && box.height > 0 ? box.height / viewport.offsetHeight : 1;
  const replyTop = (reply.getBoundingClientRect().top - box.top) / scale + viewport.scrollTop;
  const max = viewport.scrollHeight - viewport.clientHeight;
  const next = Math.min(replyTop - REPLY_TOP_GAP_PX, max);
  if (next > viewport.scrollTop + 0.5 || (settle && next < viewport.scrollTop - 0.5)) setTop(viewport, Math.max(0, next));
}
