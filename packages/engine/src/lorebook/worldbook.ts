import type { GameState, Worldbook, WorldEntry } from "../types/index.js";
import { checkConditions } from "../state/condition-evaluator.js";

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
  for (const wb of worldbooks) {
    if (wb.enabled === false) continue; // master enable toggle off → never active
    if (wb.activation.mode === "conditions") {
      if (checkConditions(state, wb.activation.conditions, wb.activation.conditionLogic)) {
        active.add(wb.id);
      }
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
    } else {
      // "always" and "manual" are both active when enabled — manual just means
      // there's no auto-rule; its on/off is the enable toggle (set by the
      // creator, or at runtime by the frontend).
      active.add(wb.id);
    }
  }
  return active;
}

/**
 * Keep only the entries whose worldbook is currently active. Entries with no
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
  if (!Array.isArray(worldbooks) || worldbooks.length === 0) return entries;
  const known = new Set(worldbooks.map((w) => w.id));
  const active = computeActiveWorldbookIds(worldbooks, state);
  return entries.filter((e) => {
    if (!e.worldbookId) return true; // Core
    if (!known.has(e.worldbookId)) return true; // orphaned → Core (fail-open)
    return active.has(e.worldbookId);
  });
}
