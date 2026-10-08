import { z } from "zod";
import { gameComponentSchema as _gameComponentSchema } from "./component-schemas.js";
import { uiBlueprintSchema as _uiBlueprintSchema } from "./ui-blueprint-schema.js";
import { uiDocSchema as _uiDocSchema } from "../ui-doc/schema.js";
import { sceneSchema as _sceneSchema } from "../spatial/schemas.js";

export const conditionSchema = z.object({
  variableId: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
  value: z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.record(z.unknown()),
    z.array(z.unknown()),
  ]),
  valueRef: z.string().optional(),
});

// Shared activation rule — worldbooks and variables gate with the same shape
// (see VariableActivation / WorldbookActivation in types/index.ts).
export const worldbookActivationSchema = z.union([
  z.object({ mode: z.literal("always") }),
  z.object({ mode: z.literal("manual") }),
  z.object({
    mode: z.literal("conditions"),
    conditions: z.array(conditionSchema).default([]),
    conditionLogic: z.enum(["all", "any"]).default("all"),
  }),
  z.object({
    mode: z.literal("greeting"),
    greetingIds: z.array(z.string()).default([]),
  }),
]);

export const variableFieldSchema = z.object({
  path: z.string().min(1).max(200),
  type: z.enum(["number", "string", "boolean", "json"]).optional(),
  label: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  writer: z.enum(["ui", "ai", "behavior", "ai-call"]).optional(),
});

export const variableSchema = z.object({
  id: z.string(),
  // Module membership: which worldbook this object belongs to (undefined = Core). Orphans fail open.
  worldbookId: z.string().optional(),
  name: z.string().min(1),
  type: z.enum(["number", "string", "boolean", "json"]),
  defaultValue: z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]),
  defaultValueText: z.string().optional(),
  description: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  // Precise tracking (continuity judge) — see types/index.ts.
  options: z.array(z.string()).optional(),
  precise: z.boolean().optional(),
  onceTrue: z.boolean().optional(),
  deltaDown: z.number().min(0).optional(),
  deltaUp: z.number().min(0).optional(),
  behaviorRules: z.string().optional(),
  // Legacy alias for behaviorRules — kept so old exports import cleanly. See types/index.ts.
  updateHints: z.string().optional(),
  // Lifecycle scope. "setup" = session-config chosen once at start (e.g. picked
  // cast); preserved across opening-switch / revert. See types/index.ts + setup-scope.ts.
  scope: z.enum(["narrative", "setup"]).optional(),
  // Engine-managed bookkeeping var (e.g. random-pick cooldown history). Never
  // rendered into <game-state>; hidden from the creator's Variables list.
  internal: z.boolean().optional(),
  // AI access tier: write (default) / read (in <game-state>, not AI-writable) /
  // none (engine+UI only, never in the prompt). See types/index.ts.
  aiAccess: z.enum(["write", "read", "none"]).optional(),
  formula: z.string().max(1000).optional(),
  persist: z.enum(["player"]).optional(),
  // When the variable is active (exposed + AI-accessible). Undefined = always.
  activation: worldbookActivationSchema.optional(),
  // Enable-gate default (default true); runtime override via @vars.enabled.<id>
  // lands in ruleState.toggledVariables and beats this in both directions.
  enabled: z.boolean().optional(),
  // Player-edit authorization for the optional Lore Shift extension. This is
  // independent from every card-authored state mutation path and fails closed.
  liveCanonEditable: z.boolean().optional().default(false),
  fields: z.array(variableFieldSchema).max(64).optional(),
});

export const effectSchema = z.object({
  variableId: z.string(),
  operation: z.enum([
    "set",
    "add",
    "subtract",
    "multiply",
    "toggle",
    "append",
    "merge",
    "push",
    "delete",
  ]),
  value: z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]),
  path: z.string().optional(),
  valueRef: z.string().optional(),
});

export const audioTrackSchema = z.object({
  preload: z.boolean().optional(),
  id: z.string(),
  name: z.string().min(1),
  type: z.enum(["bgm", "sfx", "ambient"]),
  url: z.string(),
  allowAiControl: z.boolean().optional(),
  aiNote: z.string().optional(),
  loop: z.boolean().optional(),
  volume: z.number().min(0).max(1).optional(),
  fadeIn: z.number().optional(),
  fadeOut: z.number().optional(),
  maxDuration: z.number().optional(),
});

export const sceneImageSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.string(),
  scene: z.string(),
  hint: z.string().optional(),
  greetingIds: z.array(z.string()).optional(),
  allowAiControl: z.boolean().optional(),
});

export const backgroundImageSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.string(),
  scene: z.string().optional(),
  blur: z.number().min(0).max(20).optional(),
  dim: z.number().min(0).max(80).optional(),
  opacity: z.number().min(10).max(100).optional(),
  position: z.enum(["center", "top", "bottom"]).optional(),
  greetingIds: z.array(z.string()).optional(),
  allowAiControl: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export const audioEffectSchema = z.object({
  trackId: z.string(),
  action: z.enum(["play", "stop", "crossfade", "volume"]),
  volume: z.number().min(0).max(1).optional(),
  fadeDuration: z.number().optional(),
  source: z.literal("continuity").optional(),
  duckBgm: z.boolean().optional(),
  loop: z.boolean().optional(),
  overRules: z.boolean().optional(),
});

export const bgmPlaylistSchema = z.object({
  tracks: z.array(z.string()).default([]),
  playMode: z.enum(["loop", "shuffle", "sequential"]).default("loop"),
  autoPlay: z.boolean().default(true),
  waitForFirstMessage: z.boolean().default(false),
  gapSeconds: z.number().min(0).max(30).default(0),
});

export const conditionalBGMSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  triggerType: z.enum(["variable", "ai-keyword", "keyword", "turn-count", "session-start"]).default("variable"),
  conditions: z.array(conditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"),
  keywords: z.array(z.string()).optional(),
  matchWholeWords: z.boolean().optional(),
  atTurn: z.number().int().optional(),
  everyNTurns: z.number().int().optional(),
  targetTrackId: z.string(),
  priority: z.number().int().default(0),
  fadeInDuration: z.number().min(0).default(1),
  fadeOutDuration: z.number().min(0).default(1),
  stopPreviousBGM: z.boolean().default(true),
  fallback: z.string().default("default"),
});

// ── Rules 2.0 schemas ──

export const triggerConfigSchema = z.object({
  type: z.enum(["state-change", "variable-crossed", "turn-count", "session-start", "keyword", "ai-keyword", "action", "manual", "every-turn"]),
  variableId: z.string().optional(),
  direction: z.enum(["rises-above", "drops-below"]).optional(),
  threshold: z.number().optional(),
  atTurn: z.number().int().optional(),
  everyNTurns: z.number().int().optional(),
  keywords: z.array(z.string()).optional(),
  matchWholeWords: z.boolean().optional(),
  secondaryKeywords: z.array(z.string()).optional(),
  secondaryKeywordLogic: z.enum(["AND_ANY", "AND_ALL", "NOT_ANY", "NOT_ALL"]).optional(),
  actionId: z.string().optional(),
});

export const directivePositionSchema = z.enum(["auto", "top", "before_char", "after_char", "bottom", "depth"]);

export const ruleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("modify-variable"), variableId: z.string(), operation: z.enum(["set", "add", "subtract", "multiply", "toggle", "append", "merge", "push", "delete"]), value: z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]), valueRef: z.string().optional() }),
  z.object({ type: z.literal("inject-directive"), directiveId: z.string(), content: z.string(), position: directivePositionSchema.optional().default("auto"), persistent: z.boolean().optional().default(true), duration: z.number().int().optional() }),
  z.object({ type: z.literal("remove-directive"), directiveId: z.string() }),
  z.object({ type: z.literal("send-context"), message: z.string(), role: z.enum(["system", "user"]).optional().default("system") }),
  z.object({ type: z.literal("toggle-entry"), entryId: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("toggle-rule"), ruleId: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("notify-player"), message: z.string(), style: z.enum(["info", "achievement", "warning", "danger"]).optional().default("info") }),
  z.object({ type: z.literal("play-audio"), trackId: z.string(), action: z.enum(["play", "stop", "crossfade", "volume"]), volume: z.number().min(0).max(1).optional(), fadeDuration: z.number().optional() }),
]);

export const ruleSchema = z.object({
  id: z.string(),
  // Module membership: which worldbook this object belongs to (undefined = Core). Orphans fail open.
  worldbookId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: triggerConfigSchema,
  conditions: z.array(conditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"),
  actions: z.array(ruleActionSchema).default([]),
  priority: z.number().int().default(0),
  cooldownTurns: z.number().int().optional(),
  maxFireCount: z.number().int().optional(),
  chance: z.number().min(0).max(100).optional(),
  enabled: z.boolean().default(true),
});

export const directiveSchema = z.object({
  id: z.string(),
  content: z.string(),
  position: directivePositionSchema,
  sourceRuleId: z.string(),
  persistent: z.boolean(),
  injectedAtTurn: z.number().int(),
  duration: z.number().int().optional(),
});

export const ruleRuntimeStateSchema = z.object({
  disabledRules: z.array(z.string()).default([]),
  activeDirectives: z.array(directiveSchema).default([]),
  cooldowns: z.record(z.number()).default({}),
  fireCounts: z.record(z.number()).default({}),
  prevVars: z.record(z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())])).default({}),
  toggledEntries: z.record(z.boolean()).default({}),
});

// ── Event System schemas (extensible engine) ──

const anyValue = z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]);

export const eventMatchConditionSchema = z.object({
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "every"]),
  value: z.union([z.number(), z.string(), z.boolean()]),
});

export const eventPatternSchema = z.object({
  eventType: z.string().min(1),
  match: z.record(eventMatchConditionSchema).optional(),
  _legacyTrigger: triggerConfigSchema.optional(),
});

// A random value source (range / dice / list), resolved at fire time. Lets any
// `set` effect take a random operand so randomness composes with every operation.
export const randomSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("range"), min: z.number(), max: z.number(), integer: z.boolean().optional() }),
  z.object({ kind: z.literal("dice"), count: z.number().int().min(1), sides: z.number().int().min(1), modifier: z.number().int().optional() }),
  z.object({
    kind: z.literal("list"),
    candidates: z.array(z.string()).optional(),
    candidatesVar: z.string().optional(),
    weights: z.array(z.number()).optional(),
    historyVar: z.string().optional(),
    cooldown: z.number().int().min(0).optional(),
    onExhausted: z.enum(["full", "keep"]).optional(),
  }),
]);

export const reactionEffectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set"),
    // Empty path is legal: the editor's change-variable action starts with no
    // target selected, and the engine treats "" as a no-op (resolveVariable
    // misses → effect skipped). min(1) here would reject half-configured drafts.
    path: z.string(),
    value: anyValue,
    operation: z.enum(["set", "add", "subtract", "multiply", "toggle", "append", "merge", "push", "delete"]).optional(),
    valueRef: z.string().optional(),
    valueRandom: randomSpecSchema.optional(),
  }),
  z.object({
    type: z.literal("emit"),
    event: z.object({ type: z.string().min(1) }).passthrough(),
  }),
]);

export const reactionSchema = z.object({
  id: z.string(),
  // Module membership: which worldbook this object belongs to (undefined = Core). Orphans fail open.
  worldbookId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  when: eventPatternSchema,
  conditions: z.array(conditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"),
  stopConditions: z.array(conditionSchema).optional(),
  then: z.array(reactionEffectSchema).default([]),
  priority: z.number().int().default(0),
  cooldownTurns: z.number().int().optional(),
  maxFireCount: z.number().int().optional(),
  chance: z.number().min(0).max(100).optional(),
  enabled: z.boolean().default(true),
  maxChainDepth: z.number().int().min(1).max(20).optional(),
  elseMessage: z.string().max(500).optional(),
  code: z.string().max(20000).optional(),
  custom: z.boolean().optional(),
});

/** @deprecated Use worldEntrySchema instead */
export const characterSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  avatar: z.string().optional(),
  variables: z.array(variableSchema),
});

export { gameComponentSchema } from "./component-schemas.js";
export { uiBlueprintSchema } from "./ui-blueprint-schema.js";
export { uiPackageSchema } from "./ui-package-schema.js";

/** @deprecated Use worldEntrySchema instead */
export const lorebookEntrySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: z.enum(["character", "lore", "plot", "style", "custom"]),
  content: z.string(),
  keywords: z.array(z.string()).default([]),
  conditions: z.array(conditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"),
  priority: z.number().int().default(0),
  position: z.enum(["before", "after"]).default("after"),
  enabled: z.boolean().default(true),
  alwaysSend: z.boolean().default(false),
});

export const worldEntrySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  content: z.string(),
  role: z.enum(["system", "character", "personality", "scenario", "lore", "plot", "style", "example", "greeting", "custom"]),
  apiRole: z.enum(["system", "user", "assistant"]).optional(),
  depth: z.number().int().optional(),
  alwaysSend: z.boolean().default(false),
  keywords: z.array(z.string()).default([]),
  conditions: z.array(conditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"),
  enabled: z.boolean().default(true),
  matchWholeWords: z.boolean().optional().default(false),
  secondaryKeywords: z.array(z.string()).optional().default([]),
  secondaryKeywordLogic: z.enum(["AND_ANY", "AND_ALL", "NOT_ANY", "NOT_ALL"]).optional().default("AND_ANY"),
  preventRecursion: z.boolean().optional().default(false),
  excludeRecursion: z.boolean().optional().default(false),
  position: z.number().default(0),
  section: z.enum(["system-presets", "examples", "chat-history", "post-history"]),
  tags: z.array(z.string()).optional(),
  folderId: z.string().optional(),
  presetId: z.string().optional(),
  variableBound: z.boolean().optional(),
  audience: z.enum(["ai", "player", "both"]).optional(),
  portrait: z.string().optional(),
  portraitVideo: z.object({ idle: z.string().optional(), speaking: z.string().optional() }).optional(),
  /** fish.audio reference id the character is read in. */
  voice: z.string().optional(),
  pairId: z.string().optional(),
  worldbookId: z.string().optional(),
  // Lore Shift V1 may replace content only. Missing/legacy values stay locked.
  sessionEditPolicy: z.enum(["locked", "content"]).optional().default("locked"),
  initialVariables: z
    .record(z.union([z.number(), z.string(), z.boolean()]))
    .optional(),
});

export const loreUiBindingSchema = z.object({
  slotId: z.string().min(1),
  entryId: z.string().min(1),
  conditions: z.array(conditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"),
});

/** How a station reads another module. "history" = the protagonist lived it;
 *  "lore" = an archive consulted about someone. */
const contextAsSchema = z.enum(["history", "lore"]).optional();

/** A hard ceiling, not a suggestion: raw transcript is the one input that can
 *  blow a context window open, and a creator dragging a slider has no way to
 *  feel that until a player's turn 400s. */
export const MODULE_TRANSCRIPT_MAX = 40;

export const moduleContextInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("memory"),
    from: z.string().min(1).max(128),
    as: contextAsSchema,
    limit: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    kind: z.literal("worker"),
    from: z.string().min(1).max(128),
    as: contextAsSchema,
    limit: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    kind: z.literal("variables"),
    from: z.string().min(1).max(128),
    as: contextAsSchema,
  }),
  z.object({
    kind: z.literal("transcript"),
    from: z.string().min(1).max(128),
    limit: z.number().int().min(1).max(MODULE_TRANSCRIPT_MAX),
    as: contextAsSchema,
  }),
]);

export const workerTriggerSchema = z.discriminatedUnion("on", [
  z.object({ on: z.literal("module-closed"), from: z.string().min(1).max(128) }),
  z.object({
    on: z.literal("conditions"),
    conditions: z.array(conditionSchema),
    conditionLogic: z.enum(["all", "any"]).optional(),
  }),
  z.object({ on: z.literal("turns"), every: z.number().int().min(1).max(100) }),
  z.object({ on: z.literal("after"), from: z.string().min(1).max(128) }),
  z.object({ on: z.literal("quiet"), seconds: z.number().int().min(15).max(3600) }),
  z.object({ on: z.literal("ui") }),
]);

export const moduleStationSchema = z.object({
  kind: z.enum(["narrator", "worker", "custom"]),
  model: z.string().max(200).optional(),
  inputs: z.array(moduleContextInputSchema).max(12).optional(),
  history: z.enum(["shared", "own"]).optional(),
  // narrator only — while this module answers, it reads at most this many
  // recent messages (wins over settings.historyLimit).
  historyLimit: z.number().int().min(1).max(500).optional(),
  memoryPool: z.string().min(1).max(64).optional(),
  onClose: z.enum(["archive", "keep"]).optional(),
  archivePrompt: z.string().max(2000).optional(),
  trigger: workerTriggerSchema.optional(),
  task: z.string().max(4000).optional(),
  name: z.string().max(60).optional(),
  // 自定义 — see ModuleStation in types/index.ts.
  sees: z.object({
    variables: z.array(z.string().max(200)).max(40).optional(),
    history: z.number().int().min(0).max(60).optional(),
    ownThread: z.boolean().optional(),
  }).optional(),
  pieces: z.array(z.object({
    conditions: z.array(conditionSchema).max(10),
    conditionLogic: z.enum(["all", "any"]).optional(),
    text: z.string().max(2000),
  })).max(20).optional(),
  output: z.array(z.object({
    name: z.string().min(1).max(60),
    type: z.enum(["text", "number", "choice", "list"]),
    options: z.array(z.string().max(200)).max(60).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    hint: z.string().max(400).optional(),
    to: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("say") }),
      z.object({ kind: z.literal("variable"), variableId: z.string().min(1).max(200), op: z.enum(["set", "add", "push"]).optional() }),
      z.object({ kind: z.literal("event"), name: z.string().max(120).optional() }),
    ]).optional(),
  })).max(20).optional(),
  say: z.string().max(80).optional(),
  onError: z.object({
    timeoutSec: z.number().int().min(5).max(120).optional(),
    retries: z.number().int().min(0).max(3).optional(),
    fallback: z.array(z.string().max(1000)).max(30).optional(),
    randomChoice: z.boolean().optional(),
  }).optional(),
  cooldownSec: z.number().int().min(0).max(3600).optional(),
  maxTokens: z.number().int().min(50).max(4000).optional(),
});

/** A situation can also be a door the player opens by saying a word — a
 *  mode variables do not have (see WorldbookActivation in types/index.ts). */
const worldbookOnlyActivationSchema = z.union([
  worldbookActivationSchema,
  z.object({
    mode: z.literal("keywords"),
    keywords: z.array(z.string()).default([]),
    exclusive: z.boolean().optional(),
    leaveKeywords: z.array(z.string()).optional(),
  }),
]);

export const worldbookSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  // The sticky note (便签) — creator+studio-AI blackboard memo. Capped so the
  // world snapshot it rides in stays a snapshot, not a novel.
  note: z.string().max(4000).optional(),
  // The scene file in rootComponent.files this module's interface lives in.
  // Tooling only: the entry file routes at play time.
  frontendFile: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  activation: worldbookOnlyActivationSchema,
  // 模块总控 — see types/index.ts ModuleStation. Absent = plain content module.
  station: moduleStationSchema.optional(),
  // Where an AI lives: "card", a situation's id, or "unplaced" (off).
  host: z.string().min(1).max(128).optional(),
  narratorHere: z.boolean().optional(),
  // Legacy fields, read for cards authored before the station model and
  // normalised away by resolveStation. Never written.
  runScoped: z.boolean().optional(),
  runSummaryPrompt: z.string().max(2000).optional(),
  memorySubscriptions: z
    .array(
      z.object({
        sourceBookId: z.string().min(1).max(128),
        as: z.enum(["history", "lore"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    )
    .max(8)
    .optional(),
  order: z.number().default(0),
  color: z.string().optional(),
  sourceBundleId: z.string().optional(),
});

export const customComponentSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  tsxCode: z.string(),
  description: z.string().default(""),
  order: z.number().int().default(0),
  visible: z.boolean().default(true),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

export const customUIComponentSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  surface: z.enum(["message", "app"]),
  language: z.enum(["tsx", "html", "markdown"]).default("tsx"),
  tsxCode: z.string(),
  description: z.string().default(""),
  order: z.number().int().default(0),
  visible: z.boolean().default(true),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

export const worldSettingsSchema = z.object({
  maxTokens: z.number().int().positive().optional().default(12000),
  speakerBubbles: z.boolean().optional(),
  maxContext: z.number().int().positive().optional().default(200000),
  temperature: z.number().min(0).max(2).optional().default(1.0),
  topP: z.number().min(0).max(1).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  topK: z.number().int().min(0).optional(),
  minP: z.number().min(0).max(1).optional(),
  playerName: z.string().optional().default("User"),
  /** fish.audio reference id narration is read in; a speaking character without a voice of their own falls to this. */
  narratorVoice: z.string().optional(),
  /** Voice input on release: "confirm" (fill composer) or "auto" (send as spoken). */
  voiceInputMode: z.enum(["confirm", "auto"]).optional(),
  systemPrompt: z.string().optional(),
  greeting: z.string().optional(),
  lorebookTokenBudget: z.number().int().positive().optional(),
  lorebookBudgetPercent: z.number().min(0).max(100).optional().default(100),
  lorebookBudgetCap: z.number().int().min(0).optional().default(0),
  lorebookScanDepth: z.number().int().positive().optional().default(2),
  lorebookRecursionDepth: z.number().int().min(0).max(10).optional().default(0),
  // Author-controlled history window: the story AI reads only the latest N
  // messages of the current run. Absent = everything the budget allows.
  historyLimit: z.number().int().min(1).max(500).optional(),
  // Whose context budget counts on a send: the player's per-send override
  // (default) or the card's own maxContext ("author").
  contextPolicy: z.enum(["player", "author"]).optional(),
  layoutMode: z.enum(["split", "game-focus", "immersive"]).optional().default("split"),
  uiMode: z.enum(["chat", "per-reply", "persistent"]).optional().default("chat"),
});

export const entryFolderSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  section: z.enum(["system-presets", "examples", "chat-history", "post-history"]),
  order: z.number().int(),
  collapsed: z.boolean().optional(),
  worldbookId: z.string().optional(),
});

// ── Root Component schemas ──────────────────────────────────────────

export const stateChannelSchema = z.enum(["variables", "messages", "streaming", "session", "ui"]);

export const rootComponentSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  assetLoading: z.enum(["automatic", "on-demand"]).optional(),
  entryFile: z.string().default("index.tsx"),
  files: z.record(z.string(), z.string()),
  updatedAt: z.string(),
  /** Optional pre-compiled JS (stamped at save-time) so play-time can skip the
   *  in-browser recompile. Validated against filesHash + compilerVersion before
   *  use; a stale/missing blob falls back to a fresh client compile. */
  compiled: z
    .object({
      code: z.string(),
      filesHash: z.string(),
      compilerVersion: z.number(),
    })
    .optional(),
  /** Marks these files as the output of `uiDoc` rather than as hand-written
   *  code. Its absence is what protects every card written before the
   *  interface builder existed from being silently overwritten. */
  generatedFrom: z.literal("uiDoc").optional(),
});

export const coverCropSettingsSchema = z.object({
  x: z.number().min(-45).max(45).default(0),
  y: z.number().min(-45).max(45).default(0),
  zoom: z.number().min(0.25).max(3).default(1),
  fit: z.enum(["cover", "contain"]).optional().default("cover"),
});

export const worldDefinitionSchema = z.object({
  id: z.string(),
  version: z.string().default("1.0.0"),
  name: z.string().min(1),
  description: z.string(),
  author: z.string(),
  /** @deprecated Use worlds.thumbnailUrl DB column instead. This field is unused for display. */
  avatar: z.string().optional(),
  coverCrop: coverCropSettingsSchema.optional(),
  galleryCoverCrop: coverCropSettingsSchema.optional(),
  landscapeCover: z.string().optional(),
  landscapeCoverCrop: coverCropSettingsSchema.optional(),
  entries: z.array(worldEntrySchema).default([]),
  variables: z.array(variableSchema).default([]),
  rules: z.array(ruleSchema).default([]),
  reactions: z.array(reactionSchema).optional(),
  systems: z.array(z.string()).optional(),
  scenes: z.array(_sceneSchema).optional(),
  characters: z.array(characterSchema).optional(),
  components: z.array(_gameComponentSchema).default([]),
  uiBlueprint: _uiBlueprintSchema.optional(),
  audioTracks: z.array(audioTrackSchema).default([]),
  sceneImages: z.array(sceneImageSchema).optional(),
  backgrounds: z.array(backgroundImageSchema).optional(),
  bgmPlaylist: bgmPlaylistSchema.optional(),
  conditionalBGM: z.array(conditionalBGMSchema).optional(),
  continuity: z.object({
    enabled: z.boolean().optional(),
    bgm: z.boolean().optional(),
    sfx: z.boolean().optional(),
    images: z.boolean().optional(),
    music: z.object({
      overRules: z.boolean().optional(),
      once: z.boolean().optional(),
      duck: z.boolean().optional(),
    }).optional(),
  }).optional(),
  lorebookEntries: z.array(lorebookEntrySchema).optional(),
  customUI: z.array(customUIComponentSchema).default([]),
  rootComponent: rootComponentSchema.optional(),
  /** The interface document. Never read by the runtime — save-time compiles it
   *  into `rootComponent`, which stays the only visual-layer input. */
  uiDoc: _uiDocSchema.optional(),
  customTags: z.array(z.string()).optional(),
  /** Map of custom tag name → Tailwind color class (e.g. "bg-rose-400/40").
   *  Default tags use TAG_COLORS in the app; missing custom tags fall back
   *  to a deterministic palette based on tag-name hash. */
  customTagColors: z.record(z.string()).optional(),
  entryFolders: z.array(entryFolderSchema).optional(),
  loreUiBindings: z.array(loreUiBindingSchema).optional(),
  worldbooks: z.array(worldbookSchema).optional(),
  editorMode: z.enum(["simple", "advanced"]).optional(),
  // 回复处理 — see parser/reply-rules.ts.
  replyRules: z.array(z.object({
    id: z.string().min(1).max(80),
    name: z.string().max(80).optional(),
    enabled: z.boolean().optional(),
    match: z.union([z.object({ tag: z.string().min(1).max(60) }), z.object({ pattern: z.string().min(1).max(500) })]),
    hide: z.boolean().optional(),
    to: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("fields") }),
      z.object({ kind: z.literal("variable"), variableId: z.string().min(1).max(200), op: z.enum(["set", "append", "push"]).optional() }),
      z.object({ kind: z.literal("event"), name: z.string().max(120).optional() }),
      z.object({ kind: z.literal("channel"), channel: z.string().min(1).max(80) }),
    ])).max(8).optional(),
  })).max(30).optional(),
  graphLayout: z
    .object({
      version: z.number(),
      nodes: z.record(
        z.object({
          x: z.number(),
          y: z.number(),
          collapsed: z.boolean().optional(),
          pinned: z.boolean().optional(),
          // A card-level object not yet put in a module: drawn on its own
          // on the canvas instead of as a shared row in every module.
          loose: z.boolean().optional(),
        }),
      ),
      notes: z.array(z.object({ id: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), text: z.string(), on: z.string().max(300).optional(), targets: z.array(z.string().max(300)).max(50).optional(), collapsed: z.boolean().optional(), color: z.enum(["yellow", "pink", "blue", "green"]).optional() })).optional(),
    })
    .optional(),
  settings: worldSettingsSchema,
});

export const gameStateSchema = z.object({
  worldId: z.string(),
  variables: z.record(z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())])),
  activeCharacterId: z.string().nullable().optional(),
  activeGreetingId: z.string().nullable().optional(),
  turnCount: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()),
  ruleState: ruleRuntimeStateSchema.optional(),
});
