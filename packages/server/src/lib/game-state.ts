import { GameStateManager, deepEqual } from "@yumina/engine";
import type { GameState, WorldDefinition } from "@yumina/engine";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeGameState(
  worldDef: WorldDefinition,
  state: unknown
): GameState {
  return new GameStateManager(
    worldDef,
    (isRecord(state) ? state : {}) as unknown as GameState
  ).getSnapshot();
}

export function mergeGameStatePatch(
  worldDef: WorldDefinition,
  currentState: unknown,
  patch: unknown
): GameState {
  const normalizedCurrentState = normalizeGameState(worldDef, currentState);
  const patchRecord = isRecord(patch) ? patch : {};
  const patchVariables = isRecord(patchRecord.variables)
    ? patchRecord.variables
    : {};
  const patchMetadata = isRecord(patchRecord.metadata)
    ? patchRecord.metadata
    : {};

  const mergedState: GameState = {
    ...normalizedCurrentState,
    ...(patchRecord as Partial<GameState>),
    worldId: worldDef.id,
    variables: {
      ...normalizedCurrentState.variables,
      ...(patchVariables as GameState["variables"]),
    },
    // The turn pipeline owns turnCount and ruleState; a state patch never does.
    // A custom UI patches the variables it changed, but clients have echoed
    // their whole cached `session.state` back — including the turnCount the tab
    // loaded with, which rewound the counter on every frontend write. Reaction
    // cooldowns and every-N-turns triggers are measured against it, so a counter
    // stuck at 1 means a reaction with `cooldownTurns` fires once and is locked
    // out for the rest of the session. Old cached bundles keep sending the full
    // state after a deploy, so the guard lives here as well as in the client.
    turnCount: normalizedCurrentState.turnCount,
    metadata: {
      ...normalizedCurrentState.metadata,
      ...patchMetadata,
    },
    ruleState: normalizedCurrentState.ruleState,
  };

  if (worldDef.systems?.includes("kochuu-survival-v1")) {
    // A legacy full-state UI patch may carry pre-settlement metadata. It must
    // never rewind the authoritative death ledger or award a victim twice.
    mergedState.metadata.poison = normalizedCurrentState.metadata.poison;
    mergedState.metadata.poisonTimeTurn = normalizedCurrentState.metadata.poisonTimeTurn;
    for (const id of ["game-status", "survivors", "user-kp", "npc-kp", "dead-names", "day-count"]) mergedState.variables[id] = normalizedCurrentState.variables[id]!;
    if (normalizedCurrentState.variables["player-name"]) mergedState.variables["player-name"] = normalizedCurrentState.variables["player-name"];
  }

  if ("activeCharacterId" in patchRecord) {
    mergedState.activeCharacterId = patchRecord.activeCharacterId as
      | string
      | null
      | undefined;
  }

  if ("activeGreetingId" in patchRecord) {
    mergedState.activeGreetingId = patchRecord.activeGreetingId as
      | string
      | null
      | undefined;
  }

  return normalizeGameState(worldDef, mergedState);
}

/**
 * Reconcile a message turn's final state with whatever landed in the DB while
 * the turn was streaming.
 *
 * A turn reads session state at request start and writes it back tens of
 * seconds later. `PATCH /sessions/:id/state` (every `api.setVariable` a custom
 * UI fires) takes a row lock and commits in between — and the turn's blind
 * `set state = finalState` then threw all of it away. A character-creation
 * screen that commits ~60 variables and immediately sends its opening message
 * lost every write the turn's initial read had not yet seen: 问道, 2026-09-01,
 * session 1dadfb55 kept writes 1..24 and lost 25..60 (starter kit, setup-complete,
 * 悟道 tables) the moment the first reply persisted.
 *
 * Rule: the turn owns only the keys it actually CHANGED (`turnState` vs the
 * `baseState` it read). Every untouched key keeps the live DB value, so a
 * concurrent patch survives. turnCount and ruleState stay turn-owned — the
 * engine advanced them this turn and a patch only ever echoes a stale copy back.
 */
export function reconcileTurnState(
  worldDef: WorldDefinition,
  liveState: unknown,
  baseState: GameState,
  turnState: GameState
): GameState {
  const live = normalizeGameState(worldDef, liveState);

  const variables: GameState["variables"] = { ...live.variables };
  for (const [id, value] of Object.entries(turnState.variables)) {
    if (!deepEqual(value, baseState.variables[id])) variables[id] = value;
  }

  const baseMetadata = baseState.metadata ?? {};
  const turnMetadata = turnState.metadata ?? {};
  const metadata: Record<string, unknown> = { ...(live.metadata ?? {}) };
  for (const key of new Set([
    ...Object.keys(baseMetadata),
    ...Object.keys(turnMetadata),
  ])) {
    if (!deepEqual(turnMetadata[key], baseMetadata[key])) {
      metadata[key] = turnMetadata[key];
    }
  }

  const reconciled: GameState = {
    ...turnState,
    variables,
    metadata,
  };

  // Session facts a patch may also own (opening switch, active character):
  // only overwrite when THIS turn moved them.
  if (deepEqual(turnState.activeGreetingId, baseState.activeGreetingId)) {
    reconciled.activeGreetingId = live.activeGreetingId;
  }
  if (deepEqual(turnState.activeCharacterId, baseState.activeCharacterId)) {
    reconciled.activeCharacterId = live.activeCharacterId;
  }

  return reconciled;
}
