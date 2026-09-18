import { z } from "zod";
import { gameComponentSchema as _gameComponentSchema } from "./component-schemas.js";
import { uiBlueprintSchema as _uiBlueprintSchema } from "./ui-blueprint-schema.js";
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

export const variableSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: z.enum(["number", "string", "boolean", "json"]),
  defaultValue: z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]),
  defaultValueText: z.string().optional(),
  description: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
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
  // When the variable is active (exposed + AI-accessible). Undefined = always.
  activation: worldbookActivationSchema.optional(),
  // Enable-gate default (default true); runtime override via @vars.enabled.<id>
  // lands in ruleState.toggledVariables and beats this in both directions.
  enabled: z.boolean().optional(),
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
  loop: z.boolean().optional(),
  volume: z.number().min(0).max(1).optional(),
  fadeIn: z.number().optional(),
  fadeOut: z.number().optional(),
  maxDuration: z.number().optional(),
});

export const audioEffectSchema = z.object({
  trackId: z.string(),
  action: z.enum(["play", "stop", "crossfade", "volume"]),
  volume: z.number().min(0).max(1).optional(),
  fadeDuration: z.number().optional(),
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
  pairId: z.string().optional(),
  worldbookId: z.string().optional(),
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

export const worldbookSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  activation: worldbookActivationSchema,
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
  maxContext: z.number().int().positive().optional().default(200000),
  temperature: z.number().min(0).max(2).optional().default(1.0),
  topP: z.number().min(0).max(1).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  topK: z.number().int().min(0).optional(),
  minP: z.number().min(0).max(1).optional(),
  playerName: z.string().optional().default("User"),
  systemPrompt: z.string().optional(),
  greeting: z.string().optional(),
  lorebookTokenBudget: z.number().int().positive().optional(),
  lorebookBudgetPercent: z.number().min(0).max(100).optional().default(100),
  lorebookBudgetCap: z.number().int().min(0).optional().default(0),
  lorebookScanDepth: z.number().int().positive().optional().default(2),
  lorebookRecursionDepth: z.number().int().min(0).max(10).optional().default(0),
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
  bgmPlaylist: bgmPlaylistSchema.optional(),
  conditionalBGM: z.array(conditionalBGMSchema).optional(),
  lorebookEntries: z.array(lorebookEntrySchema).optional(),
  customUI: z.array(customUIComponentSchema).default([]),
  rootComponent: rootComponentSchema.optional(),
  customTags: z.array(z.string()).optional(),
  /** Map of custom tag name → Tailwind color class (e.g. "bg-rose-400/40").
   *  Default tags use TAG_COLORS in the app; missing custom tags fall back
   *  to a deterministic palette based on tag-name hash. */
  customTagColors: z.record(z.string()).optional(),
  entryFolders: z.array(entryFolderSchema).optional(),
  loreUiBindings: z.array(loreUiBindingSchema).optional(),
  worldbooks: z.array(worldbookSchema).optional(),
  editorMode: z.enum(["simple", "advanced"]).optional(),
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
