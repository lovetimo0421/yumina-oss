import type { Worldbook } from "../types/index.js";
import { keywordMatches } from "./keyword-matcher.js";

/**
 * Switching modules by something the player said.
 *
 * The three ways a card moves between modules are meant to be one mechanism
 * seen from three sides: a variable crossing a threshold (`conditions`), the
 * interface writing that variable, and a word landing in the player's message.
 * The first two were already the same thing. This is the third.
 *
 * It is deliberately NOT how lore keywords work. A lore entry is on while its
 * word is still in the recent window and gone the moment it scrolls out —
 * correct for a piece of reference text, catastrophic for a dungeon, which
 * would close as soon as the player stopped saying its name. So a match here
 * LATCHES: it writes `ruleState.toggledWorldbooks`, which the activation gate
 * reads. Activation stays a pure function of game state (revert-safe, same
 * answer on server and client) and this is a state writer, like a reaction.
 *
 * Only the newest player message is scanned. Scanning a window would re-open a
 * dungeon the player left two turns ago, every turn, forever.
 */

export interface WorldbookSwitchResult {
  /** Modules to latch on, in the order their keywords matched. */
  on: string[];
  /** Modules to latch off — the exclusive siblings a switch closed. */
  off: string[];
}

const EMPTY: WorldbookSwitchResult = { on: [], off: [] };

/**
 * Which modules the player's message switches.
 *
 * `exclusive` is what makes a set of keyword modules a switch rather than an
 * accumulator: when one lands, its exclusive siblings go dark. A module that
 * is already on is not re-latched — it is already through the door — but it
 * still closes its siblings, because saying "back to the tavern" while in the
 * tavern should not leave the dungeon open behind you.
 */
export function matchWorldbookSwitches(
  worldbooks: Worldbook[] | undefined,
  playerMessage: string,
  current: Record<string, boolean> = {},
): WorldbookSwitchResult {
  if (!Array.isArray(worldbooks) || worldbooks.length === 0) return EMPTY;
  const text = playerMessage?.trim();
  if (!text) return EMPTY;

  const on: string[] = [];
  const exclusiveHit: string[] = [];
  const left: string[] = [];
  const says = (words: unknown) =>
    Array.isArray(words) && words.some((w) => typeof w === "string" && w.trim() && keywordMatches(text, w, false));
  for (const wb of worldbooks) {
    if (wb.enabled === false) continue;
    if (wb.activation.mode !== "keywords") continue;
    // A way out, said while inside: the latch opens. An enter word in the
    // same message wins (「从后仓出来又进后仓」 stays in), so it is checked first.
    if (current[wb.id] === true && says(wb.activation.leaveKeywords) && !says(wb.activation.keywords)) { left.push(wb.id); continue; }
    const words = wb.activation.keywords;
    if (!Array.isArray(words) || words.length === 0) continue;
    // Substring matching, like a lore entry's default: a creator writing
    // "地下室" means the word wherever it appears, and whole-word boundaries
    // do not exist in Chinese anyway.
    if (!words.some((w) => typeof w === "string" && w.trim() && keywordMatches(text, w, false))) continue;
    if (wb.activation.exclusive) exclusiveHit.push(wb.id);
    if (current[wb.id] !== true) on.push(wb.id);
  }
  if (on.length === 0 && exclusiveHit.length === 0) return left.length ? { on: [], off: left } : EMPTY;

  // Every exclusive keyword module that did NOT match closes, but only when
  // some exclusive module did — otherwise a message about nothing in
  // particular would shut the dungeon the player is standing in.
  const off: string[] = [];
  if (exclusiveHit.length > 0) {
    const hit = new Set(exclusiveHit);
    for (const wb of worldbooks) {
      if (wb.activation.mode !== "keywords" || !wb.activation.exclusive) continue;
      if (hit.has(wb.id)) continue;
      if (current[wb.id] === true) off.push(wb.id);
    }
  }
  for (const id of left) if (!off.includes(id)) off.push(id);
  return { on, off };
}

/** Apply a switch result to the latch map, returning a new map (or the same
 *  one when nothing moved, so callers can skip a write). */
export function applyWorldbookSwitches(
  current: Record<string, boolean> | undefined,
  result: WorldbookSwitchResult,
): Record<string, boolean> {
  if (result.on.length === 0 && result.off.length === 0) return current ?? {};
  const next = { ...(current ?? {}) };
  for (const id of result.on) next[id] = true;
  for (const id of result.off) next[id] = false;
  return next;
}
