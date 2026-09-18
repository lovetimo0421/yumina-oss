import type { GameState, Variable, WorldDefinition } from "@yumina/engine";
import { normalizeGameState } from "./game-state.js";

export interface ParsedCharacterCreationInput {
  playerName: string;
  timeline?: string;
  identity: string;
  technique: string;
  difficulty?: string;
  source: "new-run" | "legacy-ui-confirm";
}

export interface ResolvedCharacterCreationInput {
  playerName: string;
  timeline: string;
  identity: string;
  technique: string;
  difficulty?: string;
  difficultyModifier?: number;
  source: ParsedCharacterCreationInput["source"];
}

export interface CharacterCreationResolution {
  parsed: ResolvedCharacterCreationInput;
  canonicalUserContent: string;
  seededState: GameState;
}

const QUOTE_WRAP_RE = /^[「『“"'`]+|[」』”"'`]+$/gu;
const FIELD_RE = /^\s*([^:：\n]+)\s*[:：]\s*(.+?)\s*$/u;
const NEW_RUN_MARKER_RE = /^\s*【新周目开始】/u;
const LEGACY_CONFIRM_MARKER_RE = /^\s*\[玩家确认\]/u;

const EXPLICIT_PERSISTENT_VARIABLE_IDS = new Set([
  "fate-points",
  "achievements",
  "hidden-unlocks",
]);

const DIFFICULTY_MODIFIERS: Record<string, number> = {
  体验: 2,
  普通: 0,
  困难: -1,
  受难: -2,
  地狱: -4,
};

function cleanFieldValue(value: string): string {
  return value.trim().replace(QUOTE_WRAP_RE, "").trim();
}

function getVariableDefault(
  worldDef: WorldDefinition,
  variableId: string
): number | string | boolean | Record<string, unknown> | unknown[] | undefined {
  return worldDef.variables.find((variable) => variable.id === variableId)
    ?.defaultValue;
}

function getDefaultStringValue(
  worldDef: WorldDefinition,
  variableId: string
): string | undefined {
  const value = getVariableDefault(worldDef, variableId);
  return typeof value === "string" ? value : undefined;
}

function shouldPreserveAcrossRuns(variable: Variable): boolean {
  if (EXPLICIT_PERSISTENT_VARIABLE_IDS.has(variable.id)) {
    return true;
  }

  const searchableText = [
    variable.name,
    variable.description,
    variable.behaviorRules,
  ]
    .filter(Boolean)
    .join("\n");

  return /跨周目保留|永久解锁|永久保留/u.test(searchableText);
}

function parseLabeledFields(
  parts: string[],
  source: ParsedCharacterCreationInput["source"]
): ParsedCharacterCreationInput | null {
  const fieldMap = new Map<string, string>();

  for (const part of parts) {
    const match = part.match(FIELD_RE);
    if (!match) continue;
    const rawLabel = match[1]!.trim();
    const rawValue = cleanFieldValue(match[2]!);
    if (!rawValue) continue;
    fieldMap.set(rawLabel, rawValue);
  }

  const playerName = fieldMap.get("角色名") ?? fieldMap.get("姓名");
  const timeline = fieldMap.get("时间线");
  const identity = fieldMap.get("身份");
  const technique = fieldMap.get("术式");
  const difficulty = fieldMap.get("难度");

  if (!playerName || !identity || !technique) {
    return null;
  }

  return {
    playerName,
    timeline,
    identity,
    technique,
    difficulty,
    source,
  };
}

function parseCharacterCreationInput(
  input: string
): ParsedCharacterCreationInput | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (NEW_RUN_MARKER_RE.test(trimmed)) {
    const parts = trimmed
      .split(/\r?\n/u)
      .map((part) => part.trim())
      .filter((part) => part && !NEW_RUN_MARKER_RE.test(part));
    return parseLabeledFields(parts, "new-run");
  }

  if (LEGACY_CONFIRM_MARKER_RE.test(trimmed)) {
    const payload = trimmed.replace(LEGACY_CONFIRM_MARKER_RE, "").trim();
    const parts = payload
      .split(/\s*\|\s*/u)
      .map((part) => part.trim())
      .filter(Boolean);
    return parseLabeledFields(parts, "legacy-ui-confirm");
  }

  return null;
}

function resolveDifficultyModifier(difficulty: string | undefined): number | undefined {
  if (!difficulty) return undefined;
  return DIFFICULTY_MODIFIERS[difficulty];
}

function formatCharacterCreationMessage(
  parsed: ResolvedCharacterCreationInput
): string {
  const lines = [
    "【新周目开始】",
    `角色名：「${parsed.playerName}」`,
    `时间线：${parsed.timeline}`,
    `身份：${parsed.identity}`,
    `术式：${parsed.technique}`,
  ];

  if (parsed.difficulty) {
    lines.push(`难度：${parsed.difficulty}`);
  }

  return lines.join("\n");
}

export function diffStateVariables(
  beforeState: GameState,
  afterState: GameState
): Array<{
  variableId: string;
  oldValue: number | string | boolean | Record<string, unknown> | unknown[];
  newValue: number | string | boolean | Record<string, unknown> | unknown[];
}> {
  const changes: Array<{
    variableId: string;
    oldValue: number | string | boolean | Record<string, unknown> | unknown[];
    newValue: number | string | boolean | Record<string, unknown> | unknown[];
  }> = [];

  for (const [variableId, afterValue] of Object.entries(afterState.variables)) {
    const beforeValue = beforeState.variables[variableId];
    if (beforeValue === undefined) continue;
    if (Object.is(beforeValue, afterValue)) continue;

    changes.push({
      variableId,
      oldValue: beforeValue,
      newValue: afterValue,
    });
  }

  return changes;
}

export function resolveCharacterCreationTurn(params: {
  worldDef: WorldDefinition;
  currentState: GameState;
  rawInput: string;
  incrementRunCount: boolean;
}): CharacterCreationResolution | null {
  const parsed = parseCharacterCreationInput(params.rawInput);
  if (!parsed) return null;

  const baselineState = normalizeGameState(params.worldDef, {});
  const currentState = normalizeGameState(params.worldDef, params.currentState);

  const resolved: ResolvedCharacterCreationInput = {
    playerName: parsed.playerName,
    timeline:
      parsed.timeline ??
      getDefaultStringValue(params.worldDef, "timeline") ??
      "未指定时间线",
    identity: parsed.identity,
    technique: parsed.technique,
    difficulty:
      parsed.difficulty ??
      getDefaultStringValue(params.worldDef, "difficulty"),
    difficultyModifier: resolveDifficultyModifier(
      parsed.difficulty ??
        getDefaultStringValue(params.worldDef, "difficulty")
    ),
    source: parsed.source,
  };

  const nextVariables: GameState["variables"] = {
    ...baselineState.variables,
  };

  for (const variable of params.worldDef.variables) {
    if (!shouldPreserveAcrossRuns(variable)) continue;
    const currentValue = currentState.variables[variable.id];
    if (currentValue !== undefined) {
      nextVariables[variable.id] = currentValue;
    }
  }

  nextVariables["player-name"] = resolved.playerName;
  nextVariables["timeline"] = resolved.timeline;
  nextVariables["identity"] = resolved.identity;
  nextVariables["technique"] = resolved.technique;

  if (resolved.difficulty !== undefined && "difficulty" in nextVariables) {
    nextVariables["difficulty"] = resolved.difficulty;
  }

  if (
    resolved.difficultyModifier !== undefined &&
    "dice-modifier" in nextVariables
  ) {
    nextVariables["dice-modifier"] = resolved.difficultyModifier;
  }

  if ("run-count" in nextVariables) {
    const currentRunCount = currentState.variables["run-count"];
    const baseRunCount =
      typeof currentRunCount === "number"
        ? currentRunCount
        : typeof baselineState.variables["run-count"] === "number"
          ? baselineState.variables["run-count"]
          : 1;

    nextVariables["run-count"] = params.incrementRunCount
      ? baseRunCount + 1
      : baseRunCount;
  }

  if ("game-state" in nextVariables) {
    nextVariables["game-state"] = [
      "phase: run_start",
      `timeline: ${resolved.timeline}`,
      `identity: ${resolved.identity}`,
      `technique: ${resolved.technique}`,
      "last_action: character_creation_confirmed",
    ].join("\n");
  }

  const seededState = normalizeGameState(params.worldDef, {
    ...baselineState,
    variables: nextVariables,
  });

  return {
    parsed: resolved,
    canonicalUserContent: formatCharacterCreationMessage(resolved),
    seededState,
  };
}
