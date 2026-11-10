/** Hit-testing and element description for the frontend inspector.
 *
 *  The card's frontend renders inside an OPEN shadow root (canvas-panel's
 *  ShadowHost), which changes both halves of "what is under the cursor":
 *  `document.elementFromPoint` stops at the shadow host, and
 *  `querySelectorAll` is blind past the boundary. Everything here descends
 *  through those roots explicitly.
 */

import { SOURCE_ATTR } from "@/lib/tsx/tsx-bundler";

/** Elements the inspector draws over the card. Hit-testing has to see through
 *  them, and they must never be selectable as if they were part of the card. */
export const IGNORE_ATTR = "data-yc-ignore";

/** True when an event landed on the inspector's own layer — the drag handles,
 *  the guides — rather than on the card. The stage swallows presses while it is
 *  picking so the card's buttons do not fire; the handles are the one thing
 *  inside it that must keep receiving them. */
export function isInspectorOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${IGNORE_ATTR}]`) !== null;
}

/** The deepest element under a viewport point, shadow roots included and the
 *  inspector's own layers seen through.
 *
 *  `elementsFromPoint` (plural) returns the whole stack, so the capture layer
 *  can be skipped by reading past it. The obvious alternative — flipping the
 *  capture layer's `pointer-events` off for one lookup — is what this used to
 *  do, and it was a race: `elementFromPoint` flushes style while the layer is
 *  transparent, the browser recomputes its hover chain, and the resulting
 *  `mouseleave` arrives just after the handler that set the hover, wiping it.
 *  Intermittently. Nothing here mutates style, so nothing can fire.
 *
 *  `elementsFromPoint` stops at a shadow host; ShadowRoot has its own
 *  `elementFromPoint`, so the descent is "ask again, one level down". */
export function deepElementFromPoint(x: number, y: number): Element | null {
  const stack = document.elementsFromPoint(x, y);
  let node = stack.find((el) => !el.closest(`[${IGNORE_ATTR}]`)) as Element | undefined;
  if (!node) return null;
  // Bounded: a pathological tree of self-hosting shadow roots would otherwise
  // spin here, and an inspector that hangs the tab is worse than an imprecise
  // one. 32 is far past any real card.
  for (let depth = 0; depth < 32; depth++) {
    const root: ShadowRoot | null = (node as HTMLElement).shadowRoot;
    if (!root) break;
    const inner: Element | null = root.elementFromPoint(x, y);
    if (!inner || inner === node) break;
    node = inner;
  }
  return node;
}

/** The chain from `el` up to (and excluding) the shadow host that contains the
 *  card — root first, so it reads left-to-right as a breadcrumb.
 *
 *  `parentNode` rather than `parentElement`: crossing out of a shadow tree goes
 *  through the ShadowRoot node, and `parentElement` returns null there. A card
 *  that mounts its own nested shadow root would otherwise dead-end the chain
 *  one element in. */
export function ancestorChain(el: Element, boundary: ParentNode | null): Element[] {
  const chain: Element[] = [];
  let node: Node | null = el;
  while (node && node !== boundary) {
    if (node instanceof Element) chain.push(node);
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return chain.reverse();
}

/** Element children, descending into a shadow root when the element has one —
 *  what "↓ goes into this block" has to mean for a card that nests hosts. */
export function elementChildren(el: Element): Element[] {
  const shadow = (el as HTMLElement).shadowRoot;
  const source = shadow ?? el;
  return Array.from(source.children);
}

export interface ElementDescription {
  /** `div.hp-bar` / `button#send` / `span` — the DevTools shorthand. */
  label: string;
  tag: string;
  /** Trimmed to what fits a breadcrumb; a card built on utility CSS can carry
   *  thirty class names on one node and none of them identify it. */
  classes: string[];
  /** Directly authored text, excluding descendants' — a heading reads as its
   *  own words, while a wrapper full of children stays anonymous. */
  ownText: string;
}

export function describeElement(el: Element): ElementDescription {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes = (typeof el.className === "string" ? el.className : "")
    .split(/\s+/)
    .filter(Boolean);
  // Utility frameworks make the first class as arbitrary as the last, so the
  // label shows two and the panel lists the rest.
  let shown = classes.slice(0, 2).map((c) => `.${c}`).join("");
  // Cards that style inline — a large share of them — give every node the same
  // name, and a breadcrumb reading `div › div › div › div` is a breadcrumb that
  // cannot be navigated. The source line is the distinguishing thing those
  // elements do have.
  if (!id && !shown) {
    const ref = ownSourceRef(el);
    if (ref) shown = `:${ref.line}`;
  }
  let ownText = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) ownText += node.textContent ?? "";
  }
  ownText = ownText.trim().replace(/\s+/g, " ").slice(0, 60);
  return { label: `${tag}${id}${shown}`, tag, classes, ownText };
}

export interface SourceRef {
  file: string;
  line: number;
}

/** The `file:line` stamped on this element by the inspect build. */
export function ownSourceRef(el: Element): SourceRef | null {
  const raw = el.getAttribute?.(SOURCE_ATTR);
  if (!raw) return null;
  const at = raw.lastIndexOf(":");
  if (at <= 0) return null;
  const line = Number(raw.slice(at + 1));
  if (!Number.isFinite(line) || line < 1) return null;
  return { file: raw.slice(0, at), line };
}

/** The nearest source location at or above `el`.
 *
 *  Not every node has one: platform building blocks (`<Chat>`, `<MessageList>`)
 *  are compiled app code, and a card that sets `innerHTML` produces nodes no
 *  JSX ever named. Walking up finds the closest thing the creator actually
 *  wrote, which is the honest answer to "show me this in the code". */
export function nearestSourceRef(
  el: Element,
  boundary: ParentNode | null,
): { ref: SourceRef; element: Element } | null {
  const chain = ancestorChain(el, boundary);
  for (let i = chain.length - 1; i >= 0; i--) {
    const ref = ownSourceRef(chain[i]);
    if (ref) return { ref, element: chain[i] };
  }
  return null;
}

/** The knob group region this element belongs to, if any — the decomposed
 *  frontend's own idea of "a block", which predates the inspector and stays
 *  authoritative where it exists. */
/**
 * The uiDoc element the click landed in.
 *
 * A compiled element's root carries `data-ui-el`, but the click lands on
 * whatever is inside it — the span holding a label, the div painting a track.
 * Walking up to the nearest stamped ancestor is what turns "the pixel they hit"
 * into "the part they meant".
 */
export function nearestUiElementId(el: Element, boundary: ParentNode | null): string | null {
  const chain = ancestorChain(el, boundary);
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i].getAttribute?.("data-ui-el");
    if (id) return id;
  }
  return null;
}

export function nearestKnobGroup(el: Element, boundary: ParentNode | null): string | null {
  const chain = ancestorChain(el, boundary);
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i].getAttribute?.("data-knob-group");
    if (id) return id;
  }
  return null;
}
