import type { GameState, Worldbook, WorldEntry } from "../types/index.js";
import { checkConditions } from "../state/condition-evaluator.js";
import { activeNarrator, resolveStation } from "./station.js";

/**
 * Compute which worldbooks are currently "online" for the given state.
 * `always`-mode books are always active; `conditions`-mode books are active
 * when their conditions pass. The result is a pure function of game state, so
 * it is identical on the server (prompt) and the client (UI), and survives
 * revert/branch because the underlying variables are snapshotted.
 */
export function computeActiveWorldbookIds(
  worldbooks: Worldbook[] | undefined,
  state: GameState,
): Set<string> {
  const active = new Set<string>();
  if (!Array.isArray(worldbooks)) return active;
  const switched = state.ruleState?.toggledWorldbooks ?? {};
  for (const wb of worldbooks) {
    if (wb.enabled === false) continue; // master enable toggle off → never active
    if (wb.activation.mode === "conditions") {
      if (checkConditions(state, wb.activation.conditions, wb.activation.conditionLogic)) {
        active.add(wb.id);
      }
    } else if (wb.activation.mode === "keywords") {
      // A keyword is a door the player walked through, not a word still
      // hanging in the air: the match latched `toggledWorldbooks` when it
      // happened, and this reads the latch. Nothing said yet, nothing on.
      if (switched[wb.id] === true) active.add(wb.id);
    } else if (wb.activation.mode === "greeting") {
      // Active only when the session's current opening matches one of the listed IDs.
      // `activeGreetingId` is a first-class, normalization-preserved GameState field
      // (the server sets it at session creation and on opening-switch). It must NOT
      // live in `state.variables` — undeclared variable keys are stripped by
      // GameStateManager.normalizeState, which silently disabled this gate before.
      const current = String(state.activeGreetingId ?? "");
      if (current && wb.activation.greetingIds.includes(current)) {
        active.add(wb.id);
      }
    } else if (wb.activation.mode === "manual") {
      // No auto-rule: the creator's enable toggle is the default, and a
      // runtime switch beats it in both directions — same shape as
      // toggledEntries over an entry's `enabled`.
      if (switched[wb.id] !== false) active.add(wb.id);
    } else {
      active.add(wb.id); // "always"
    }
  }
  // An AI that lives somewhere is in play exactly when that place is: on the
  // card, always; in a situation, while the situation is on. Its own
  // activation is not read. Not put anywhere yet is off, and so is one put
  // inside another AI — a place is a situation, never an AI that lives in one.
  for (const wb of worldbooks) {
    if (wb.host === undefined) continue;
    active.delete(wb.id);
    if (wb.enabled === false) continue;
    if (wb.host === "card") { active.add(wb.id); continue; }
    const place = worldbooks.find((b) => b.id === wb.host);
    if (place && place.host === undefined && active.has(place.id)) active.add(wb.id);
  }
  return active;
}

/**
 * Whether a module member (variable, reaction, rule, entry, …) is currently
 * active, given the worldbook it claims membership of. The shared membership
 * rule for every member type:
 *   - no `worldbookId` → implicit always-on Core → active;
 *   - card has no worldbooks / unknown book id → fail open (never silently
 *     disable content);
 *   - otherwise → active iff the book is active for this state.
 * Pure function of game state — same result on server and client, revert-safe.
 * Book activation conditions read RAW variable values (checkConditions), never
 * a variable's own activation, so module gating cannot form cycles.
 */
/**
 * Not placed anywhere yet: an entry, variable or behaviour added from the
 * canvas's 添加内容 stands outside every frame, drawn faded, and is in play
 * nowhere until the creator drags it onto the card or into a situation.
 * Unlike an id that points at a deleted situation (which fails open), this
 * one is deliberate and always off.
 */
export const UNPLACED_WORLDBOOK_ID = "unplaced";

export function isMemberActive(
  worldbookId: string | undefined,
  worldbooks: Worldbook[] | undefined,
  state: GameState,
): boolean {
  if (worldbookId === UNPLACED_WORLDBOOK_ID) return false;
  if (!worldbookId) return true; // Core
  if (!Array.isArray(worldbooks) || worldbooks.length === 0) return true;
  if (!worldbooks.some((w) => w.id === worldbookId)) return true; // orphan → fail open
  return computeActiveWorldbookIds(worldbooks, state).has(worldbookId);
}

/**
 * Keep player-facing entries whose worldbook is currently active. A worker's
 * entries are its private persona, read directly by the worker runner; being
 * active lets the worker run, not speak through the player's narrator.
 * Entries with no
 * `worldbookId` belong to the implicit always-on "Core" book and are always
 * kept. An entry pointing at an unknown/deleted worldbook is treated as Core
 * (fail-open — never silently drop lore). When the card has no worldbooks the
 * entries pass through untouched (full back-compat with pre-worldbook cards).
 *
 * This runs as a pre-filter BEFORE the keyword/condition matcher, so the
 * existing matching, sectioning, recursion and token budget are unchanged —
 * they just operate on the active subset.
 */
export function filterEntriesByActiveWorldbooks(
  entries: WorldEntry[],
  worldbooks: Worldbook[] | undefined,
  state: GameState,
): WorldEntry[] {
  entries = entries.filter((e) => e.worldbookId !== UNPLACED_WORLDBOOK_ID);
  if (!Array.isArray(worldbooks) || worldbooks.length === 0) return entries;
  const known = new Set(worldbooks.map((w) => w.id));
  const workers = new Set(worldbooks.filter((w) => resolveStation(w)?.kind === "worker").map((w) => w.id));
  const active = computeActiveWorldbookIds(worldbooks, state);
  // In a room of several AIs, what only one of them knows reaches only that
  // one. The player-facing reply is the room's first voice; the others answer
  // after it with prompts of their own.
  const speaker = activeNarrator(worldbooks, active);
  const otherVoices = new Set(
    worldbooks
      .filter((w) => w.host !== undefined && resolveStation(w)?.kind === "narrator" && w.id !== speaker?.id)
      .map((w) => w.id),
  );
  return entries.filter((e) => {
    if (!e.worldbookId) return true; // Core
    if (!known.has(e.worldbookId)) return true; // orphaned → Core (fail-open)
    if (workers.has(e.worldbookId)) return false;
    if (otherVoices.has(e.worldbookId)) return false;
    return active.has(e.worldbookId);
  });
}
