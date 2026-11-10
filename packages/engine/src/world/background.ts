import { COVER_BACKGROUND_URL, type BackgroundImage, type WorldDefinition } from "../types/index.js";

/** Just the slice of game state this module reads. Deliberately looser than
 *  `Pick<GameState, "variables">`: callers hand us live session state whose
 *  values are `unknown` until the engine narrows them, and a background lookup
 *  has no business forcing that narrowing on them. */
export interface BackgroundStateSlice {
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** The variable that names the background on screen.
 *
 *  Reserved, not authored: the name was already load-bearing before this
 *  feature existed — `IncrementalSegmentExtractor` reads `currentBg` out of a
 *  structured reply and the server streams it as the `bg` SSE event. Keeping
 *  that spelling means a card that already drives its own background through
 *  structured output keeps working, and a behaviour that sets this variable
 *  changes the picture with no new effect kind. */
export const BACKGROUND_VARIABLE = "currentBg";

/** Where the platform stores the handle when the AI writes `[bg: id]`.
 *
 *  Metadata rather than a variable because `currentBg` is not something the
 *  author declared: `GameStateManager.set` refuses a write to a variable the
 *  world never defined, and auto-declaring one would put a slot the author
 *  never asked for into their variable list, their prompt and their canvas. */
export const BACKGROUND_METADATA_KEY = "currentBg";

/** A background resolved down to what a renderer needs. No handles, no
 *  sentinels — `url` is final, `dim` and `opacity` are 0–1 multipliers. */
export interface ResolvedBackground {
  id: string;
  url: string;
  blur: number;
  dim: number;
  /** The picture's own alpha. `dim` lays black OVER the area; this decides
   *  how much of the picture is there at all, and lets the card's own
   *  background show through instead of turning everything black. */
  opacity: number;
  position: "center" | "top" | "bottom";
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Treatment defaults. A picture with no treatment at all is the failure mode
 *  this feature exists to prevent, so an author who never touches the sliders
 *  still gets something text can be read over. */
export const DEFAULT_BLUR = 6;
export const DEFAULT_DIM = 40;
/** Fully there. An author who wants a watermark turns this down; one who
 *  wants the text readable turns DIM up. They are different questions. */
export const DEFAULT_OPACITY = 100;

export function backgroundById(
  world: Pick<WorldDefinition, "backgrounds">,
  id: string | null | undefined,
): BackgroundImage | null {
  if (!id) return null;
  return (world.backgrounds ?? []).find((b) => b.id === id) ?? null;
}

/**
 * Which background this turn shows, as a handle. Three sources, most specific
 * first:
 *
 * 1. `currentBg` in state — set by a behaviour, an opening's seed, or the AI.
 * 2. A background that names this opening in `greetingIds`.
 * 3. The one flagged `isDefault`, else the first that could apply.
 *
 * A `currentBg` naming a background that no longer exists falls through rather
 * than blanking the screen: deleting a picture should not leave sessions that
 * referenced it staring at nothing.
 */
export function activeBackgroundId(
  world: Pick<WorldDefinition, "backgrounds">,
  state: BackgroundStateSlice | null | undefined,
  activeGreetingId?: string | null,
): string | null {
  const list = world.backgrounds ?? [];
  if (list.length === 0) return null;

  // Metadata first (the platform's own slot), then the variable — a card that
  // already drove its own background through structured output declared
  // `currentBg` itself, and that still works.
  const named = state?.metadata?.[BACKGROUND_METADATA_KEY] ?? state?.variables?.[BACKGROUND_VARIABLE];
  if (typeof named === "string" && named) {
    const hit = list.find((b) => b.id === named);
    if (hit) return hit.id;
  }

  if (activeGreetingId) {
    const forOpening = list.find((b) => (b.greetingIds ?? []).includes(activeGreetingId));
    if (forOpening) return forOpening.id;
  }

  // Only backgrounds that are not pinned to some OTHER opening can be the
  // fallback — a picture the author scoped to one opening must not leak into
  // the rest of the card just because nothing else claimed the slot.
  const unscoped = list.filter((b) => (b.greetingIds ?? []).length === 0);
  const flagged = unscoped.find((b) => b.isDefault);
  if (flagged) return flagged.id;
  return unscoped[0]?.id ?? null;
}

/**
 * The picture a renderer should paint, with the cover sentinel already
 * substituted and the treatment filled in.
 *
 * `coverUrl` is passed in rather than read off the world because the cover
 * lives on the DB row, not in the schema, and the host already resolves it to
 * an absolute URL for the sandbox.
 */
export function resolveBackground(
  world: Pick<WorldDefinition, "backgrounds">,
  state: BackgroundStateSlice | null | undefined,
  opts?: { activeGreetingId?: string | null; coverUrl?: string | null },
): ResolvedBackground | null {
  const id = activeBackgroundId(world, state, opts?.activeGreetingId);
  const bg = backgroundById(world, id);
  if (!bg) return null;

  const url = bg.url === COVER_BACKGROUND_URL ? (opts?.coverUrl ?? "") : bg.url;
  // A cover-backed background on a card with no cover yet paints nothing —
  // better than a broken image behind every message.
  if (!url) return null;

  return {
    id: bg.id,
    url,
    blur: clamp(bg.blur ?? DEFAULT_BLUR, 0, 20),
    dim: clamp(bg.dim ?? DEFAULT_DIM, 0, 80) / 100,
    opacity: clamp(bg.opacity ?? DEFAULT_OPACITY, 10, 100) / 100,
    position: bg.position ?? "center",
  };
}

/** The backgrounds the AI is allowed to switch to, with the sentences that
 *  tell it when. Empty when the card has none it may drive, which is what
 *  keeps the prompt block off cards that do not use this. */
export function aiSelectableBackgrounds(
  world: Pick<WorldDefinition, "backgrounds">,
  activeGreetingId?: string | null,
): BackgroundImage[] {
  return (world.backgrounds ?? []).filter((b) => {
    if (b.allowAiControl === false) return false;
    if (!b.scene?.trim()) return false;
    const scope = b.greetingIds ?? [];
    if (scope.length > 0 && activeGreetingId && !scope.includes(activeGreetingId)) return false;
    return true;
  });
}

/** Next free `bg1`, `bg2`, … The handle is a token the model has to reproduce
 *  exactly, so it stays short and predictable rather than a uuid. */
export function nextBackgroundId(existing: readonly { id: string }[]): string {
  let n = 1;
  const taken = new Set(existing.map((b) => b.id));
  while (taken.has(`bg${n}`)) n += 1;
  return `bg${n}`;
}
