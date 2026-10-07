import type { WorldDefinition } from "@yumina/engine";
import { isDefaultWorldName } from "@yumina/shared";

/**
 * How finished a card is, as a list the author can act on.
 *
 * Shown on the canvas frame header, so a creator knows where they stand while
 * they work rather than hearing it first as a rejection.
 *
 * Deliberately NOT the publish gate. That gate lives in the publish modal,
 * mirrors the server's NAME_REQUIRED / COVER_REQUIRED guards, and runs against
 * the saved world record. This reads the local draft, so it is advisory and
 * wider: it also counts an opening and some setting, which nothing blocks
 * publishing without but every playable card has. Advisory is why it can be
 * wider — a count that guides is free to ask for more than a rule that
 * refuses, and only the modal is ever allowed to say no.
 *
 * Deliberately NOT a second checklist to maintain. Every item is derived from
 * content that is already on the board — a block being non-empty, a cover
 * existing — so nothing here can drift out of step with what the author sees.
 */

export type ReadinessId = "name" | "cover" | "opening" | "setting" | "mechanics";

export interface ReadinessItem {
  id: ReadinessId;
  done: boolean;
  /** False for items a perfectly good card may skip. A pure-prose card has no
   *  business being told it is incomplete for having no variables. */
  required: boolean;
  /** How many of the thing there are, when the count is worth showing. */
  count?: number;
}

export interface CardReadiness {
  items: ReadinessItem[];
  /** Required items only — the publish gate's own arithmetic. */
  doneRequired: number;
  totalRequired: number;
  /** Everything, including the optional ones. What the canvas header shows,
   *  because a creator deciding what to do next cares about the whole card. */
  done: number;
  total: number;
  /** Required items still outstanding, in the order they should be fixed. */
  missing: ReadinessItem[];
}

/** Placeholder text a template seeded. An opening that still says
 *  "[the first thing players see…]" is not an opening. */
function isPlaceholder(text: string | undefined | null): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return true;
  // Templates write their guidance inside brackets, in every language we ship.
  // A body that is nothing but one bracketed block is still the template's.
  return /^[[【]/.test(trimmed) && /[\]】]$/.test(trimmed);
}

export function cardReadiness(
  world: Pick<WorldDefinition, "name" | "entries" | "variables"> & {
    reactions?: unknown[];
    rules?: unknown[];
    avatar?: string;
  },
): CardReadiness {
  const entries = world.entries ?? [];
  const greetings = entries.filter((e) => e.role === "greeting");
  const written = greetings.filter((e) => !isPlaceholder(e.content));
  const lore = entries.filter((e) => e.role !== "greeting" && !isPlaceholder(e.content));
  const mechanics = (world.variables?.length ?? 0) + (world.reactions?.length ?? 0) + (world.rules?.length ?? 0);

  const items: ReadinessItem[] = [
    { id: "name", done: !isDefaultWorldName(world.name), required: true },
    { id: "cover", done: Boolean(world.avatar), required: true },
    { id: "opening", done: written.length > 0, required: true, count: written.length },
    { id: "setting", done: lore.length > 0, required: true, count: lore.length },
    // Optional on purpose: plenty of published cards are pure prose, and a
    // checklist that calls them unfinished is a checklist authors learn to
    // ignore.
    { id: "mechanics", done: mechanics > 0, required: false, count: mechanics },
  ];

  const required = items.filter((i) => i.required);
  return {
    items,
    doneRequired: required.filter((i) => i.done).length,
    totalRequired: required.length,
    done: items.filter((i) => i.done).length,
    total: items.length,
    missing: required.filter((i) => !i.done),
  };
}
