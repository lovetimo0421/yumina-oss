/**
 * Viewport units, re-aimed at the frame the card is drawn in.
 *
 * A third of the custom interfaces in the library lay themselves out with
 * `100vw × 100vh` and centre a phone-shaped frame inside that — which is
 * right when the card has the whole browser window, and is what the player
 * gets. The board's interface block does not give it the window: it is a
 * shadow root in a 400px box, so `100vh` there is the height of the whole
 * Studio, and the phone frame lands somewhere off the block's right edge.
 * The block showed the card's background gradient and nothing else.
 *
 * Container query units mean the same thing measured against the nearest
 * size container instead of the window, and the block's frame IS a size
 * container (`container-type: size`). So, for the block only, every viewport
 * unit in the card's sources becomes its container twin: `100vh` → `100cqh`.
 * The digits have to touch the unit (`50vh`, `.5vw`, `100dvh`), which is
 * how every real stylesheet and inline style writes them and how nothing
 * else in a TSX file does — an identifier cannot start with a digit.
 *
 * What this cannot reach: `window.innerWidth` / `innerHeight` read from
 * script. Those cards still measure the window; they are the minority, and
 * an iframe is the only honest answer for them.
 */
const VIEWPORT_UNIT = /(\d)(?:[sld]?v)(w|h|min|max|i|b)\b/g;

/** `100vh` → `100cqh` in one source string. */
export function viewportUnitsToContainer(source: string): string {
  return source.replace(VIEWPORT_UNIT, "$1cq$2");
}

/** The same, over a card's file map. Files without a viewport unit come
 *  back as the same string, so a memo keyed on them still holds. */
export function viewportUnitsToContainerFiles(files: Record<string, string>): Record<string, string> {
  let changed = false;
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(files)) {
    const next = viewportUnitsToContainer(source);
    if (next !== source) changed = true;
    out[name] = next;
  }
  return changed ? out : files;
}
