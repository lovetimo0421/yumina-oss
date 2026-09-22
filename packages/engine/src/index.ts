export { getAiAudioTracks, filterAiAudioEffects, isLoopingTrack, filterResumableAudioEffects } from "./audio/ai-audio.js";

// Types
export type {
  Variable,
  VariableActivation,
  Condition,
  Rule,
  RuleTrigger,
  RuleNotification,
  Effect,
  EffectOperation,
  Character,
  WorldDefinition,
  WorldSettings,
  GameState,
  AudioTrack,
  AudioEffect,
  BGMPlaylist,
  ConditionalBGM,
  BGMTriggerType,
  LorebookEntry,
  WorldEntry,
  LoreUiBinding,
  Worldbook,
  WorldbookActivation,
  EntryFolder,
  InstalledBundle,
  CustomComponent,
  CustomUIComponent,
  StateChannel,
  RootComponent,
  UIBlueprint,
  UIBlueprintTheme,
  UIBlueprintLayout,
  UIBlueprintLayoutType,
  UIBlueprintComponent,
  UIBlueprintComponentType,
  UIBlueprintBinding,
  UIBindingTransform,
  UIBlueprintTrigger,
  UIBlueprintCondition,
  UIBlueprintInteraction,
  UIBlueprintInteractionAction,
  UIBlueprintInteractionEvent,
  UIBlueprintTriggerStatus,
  UIBlueprintTriggerTrace,
  UIBlueprintNodeTrace,
  UIPackageFormat,
  UIPackageUIType,
  UIPackageImplementation,
  UIPackageAuthoringMode,
  UIPackageMetadata,
  UIPackageSummary,
  UIPackageMessageRenderer,
  UIPackageDisplaySettings,
  UIPackage,
  UIPackageValidationResult,
  UIPackageCollectionDiff,
  UIPackageDiff,
  UIPackageExportSeed,
  UIPackageValidationOptions,
  UIPackageVariableRef,
  UIPackageWorldValidationContext,
  YuminaBundle,
  // Rules 2.0
  TriggerType,
  TriggerConfig,
  RuleAction,
  DirectivePosition,
  NotificationStyle,
  Directive,
  RuleRuntimeState,
} from "./types/index.js";

// Component types
export type {
  ComponentType,
  GameComponent,
  StatBarComponent,
  TextDisplayComponent,
  ImagePanelComponent,
  InventoryGridComponent,
  WebPanelComponent,
  StatBarConfig,
  TextDisplayConfig,
  ImagePanelConfig,
  InventoryGridConfig,
  WebPanelConfig,
  ComponentTypeMeta,
} from "./types/index.js";

export { COMPONENT_TYPE_META } from "./types/index.js";

// Schemas
export {
  variableSchema,
  conditionSchema,
  effectSchema,
  ruleSchema,
  characterSchema,
  gameComponentSchema,
  worldSettingsSchema,
  worldDefinitionSchema,
  gameStateSchema,
  audioTrackSchema,
  audioEffectSchema,
  bgmPlaylistSchema,
  conditionalBGMSchema,
  lorebookEntrySchema,
  worldEntrySchema,
  entryFolderSchema,
  customComponentSchema,
  customUIComponentSchema,
  stateChannelSchema,
  rootComponentSchema,
  uiBlueprintSchema,
  uiPackageSchema,
  // Rules 2.0 schemas
  triggerConfigSchema,
  directivePositionSchema,
  ruleActionSchema,
  directiveSchema,
  ruleRuntimeStateSchema,
  // Event system schemas
  eventMatchConditionSchema,
  eventPatternSchema,
  reactionEffectSchema,
  reactionSchema,
} from "./world/schema.js";

// State
export { GameStateManager } from "./state/game-state-manager.js";

// Rules
export { createEmptyRuleState } from "./rules/rule-state.js";

// Prompts
export { PromptBuilder } from "./prompts/prompt-builder.js";
export {
  NARRATOR_SPEAKER,
  portraitCharacters,
  displayCharacterName,
  speakerTagEnabled,
  parseLeadingSpeakerTag,
  isPartialLeadingSpeakerTag,
  buildSpeakerFormatBlock,
} from "./prompts/speaker-tag.js";
export type { SpeakerTagParse } from "./prompts/speaker-tag.js";
export type { ChatMessage, UserPrompt, PromptCostBreakdown, PromptCostBlock } from "./prompts/prompt-builder.js";
export { expandMacros } from "./prompts/macros.js";
export type { MacroContext } from "./prompts/macros.js";
export { estimateTokens, estimateTokensFromMetrics, preloadTokenizer } from "./prompts/token-utils.js";

// Components
export { resolveUIBlueprint } from "./components/index.js";
export type {
  ResolvedComponent,
  ResolvedStatBar,
  ResolvedTextDisplay,
  ResolvedImagePanel,
  ResolvedInventoryGrid,
  ResolvedWebPanel,
  ResolvedError,
  ResolvedUIBlueprintResult,
} from "./components/index.js";

// Entries
export { deriveSectionDefaults, deriveSectionDefaultsForEntry } from "./entries/section-defaults.js";
export { OFFICIAL_PRESETS } from "./entries/official-presets.js";
export type { OfficialPreset } from "./entries/official-presets.js";

// Lorebook
export { LorebookMatcher } from "./lorebook/lorebook-matcher.js";
export type { LorebookMatchResult } from "./lorebook/lorebook-matcher.js";
export {
  classifyEntryTriggerCategory,
  getActiveLoreSlots,
  getEntryBoundSlotId,
  getUiBoundEntryIds,
  isLoreSlotActive,
  isUiBoundEntry,
  isVariableBoundEntry,
} from "./lorebook/entry-triggers.js";
export type { EntryTriggerCategory } from "./lorebook/entry-triggers.js";
export { checkConditions, evaluateCondition } from "./state/condition-evaluator.js";
export { preserveSetupScopedVariables } from "./state/setup-scope.js";
export {
  isVariableActive,
  isAiReadable,
  isAiWritable,
  resolveActiveVariableIds,
  filterAiEffects,
} from "./state/variable-activation.js";
export { keywordMatches } from "./lorebook/keyword-matcher.js";
export {
  extractLoreSlotsFromFiles,
} from "./lorebook/lore-slot-scan.js";
export type { LoreSlotDescriptor } from "./lorebook/lore-slot-scan.js";
export {
  resolveLoreSlotContent,
  filterEntriesByActiveLoreSlots,
} from "./lorebook/lore-slot.js";
export type { ResolvedLoreSlot } from "./lorebook/lore-slot.js";
export {
  computeActiveWorldbookIds,
  filterEntriesByActiveWorldbooks,
} from "./lorebook/worldbook.js";

// Parser
export { ResponseParser } from "./parser/response-parser.js";
export type { ParseResult } from "./parser/response-parser.js";
export { StructuredResponseParser } from "./parser/structured-response-parser.js";
export { IncrementalSegmentExtractor } from "./parser/incremental-segment-extractor.js";
export type { ExtractedSegment, ExtractionResult } from "./parser/incremental-segment-extractor.js";
export { parseImageEmbeds, renderImageEmbedHtml, isImageEmbedSource } from "./parser/image-embed-parser.js";
export { ThinkingTagFilter } from "./parser/thinking-tag-filter.js";
export type { ImageEmbed, ImageEmbedPlacement, ImageEmbedSize, ParsedImageEmbeds } from "./parser/image-embed-parser.js";

// Migration
export {
  migrateWorldDefinition,
  migrateV18ToV19,
  migrateV19ToV20,
  migrateV20ToV21,
  makeDefaultRootComponent,
  customUIToRootFiles,
  DEFAULT_CHAT_ROOT,
} from "./migration/migrate-v1-to-v2.js";

// Validation
export { validateWorld } from "./validation/world-validator.js";
export type { WorldWarning } from "./validation/world-validator.js";

// World schema diff
export { diffWorldSchemas } from "./diff/world-diff.js";
export type { WorldDiff, WorldChange, WorldChangeKind, WorldFieldChange } from "./diff/world-diff.js";

// Entry → folder referential-integrity heal (prevents orphaned/hidden entries)
export { normalizeFolders } from "./world/normalize-folders.js";
export type { NormalizeFoldersResult } from "./world/normalize-folders.js";

// 3-way world merge (conflict resolution for the editor↔agent save race)
export { mergeWorldDefinition, deepEqual } from "./world/merge.js";
export type { WorldMergeResult, WorldMergeConflict } from "./world/merge.js";

// Material-change detection (edit re-review gate for published worlds)
export { detectMaterialChange } from "./diff/material-change.js";
export type { MaterialChangeReason, MaterialSnapshot, MaterialChangeResult } from "./diff/material-change.js";

// UI package tools
export {
  validateUIPackage,
  diffUIPackageAgainstWorld,
  exportUIPackageFromWorld,
} from "./ui-package/tools.js";

// Import (ST card importer removed — only native Yumina JSON import supported)

// ── Event System (extensible engine core) ──

// Event types
export type {
  GameEvent,
  EventPattern,
  EventMatchOperator,
  EventMatchCondition,
  Reaction,
  ReactionEffect,
  RandomSpec,
  EventHandler,
} from "./events/types.js";

// Event bus
export { EventBus } from "./events/event-bus.js";

// Event matching
export { matchesEventPattern } from "./events/event-matcher.js";

// ── Reaction System (evolution of Rules) ──

export { ReactionEvaluator, sampleRandomSpec } from "./reactions/reaction-evaluator.js";
export type { ReactionEvalResult } from "./reactions/reaction-evaluator.js";
export { runReactionChain } from "./reactions/reaction-runner.js";
export type { ReactionRunResult } from "./reactions/reaction-runner.js";

// Rule → Reaction compiler (backward compat migration)
export {
  compileRuleToReaction,
  compileRulesToReactions,
  compileTriggerToPattern,
  compileActionsToEffects,
  buildTurnCompleteEvent,
  buildMessageUserEvent,
  buildMessageAIEvent,
  buildSessionStartEvent,
  buildActionFiredEvent,
  buildStateChangedEvent,
  buildStateCrossedEvent,
} from "./reactions/compile-rule.js";

// Reaction id remapping (bundle import into a world with different ids)
export { remapReactionReferences } from "./reactions/remap.js";
export type { ReactionIdRemap } from "./reactions/remap.js";

// ── System Registry (plugin infrastructure) ──

export type {
  SystemDefinition,
  EventDefinition,
  EventFieldDefinition,
  StatePathDefinition,
} from "./systems/types.js";

export { SystemRegistry, BUILT_IN_SYSTEMS } from "./systems/registry.js";

// System effect processing (@ variable → side effect bridge)
export { processSystemEffects, applySystemEffects } from "./systems/effect-processor.js";
export type { SystemEffectResult } from "./systems/effect-processor.js";

// ── Spatial System (plugin) ──

export type { Scene, Zone, SceneEntity, SceneExit, SpatialState } from "./spatial/types.js";
export { SpatialRuntime } from "./spatial/runtime.js";
export { SPATIAL_SYSTEM } from "./spatial/system.js";
export { sceneSchema, zoneSchema, sceneEntitySchema, sceneExitSchema } from "./spatial/schemas.js";

// ── Timer System (plugin) ──

export type { Timer, TimerState } from "./timer/types.js";
export { TimerRuntime } from "./timer/runtime.js";
export { TIMER_SYSTEM } from "./timer/system.js";

// Combat
export { resolveCombatTurn } from "./combat/resolve-turn.js";
export type {
  PlayerStats,
  EnemyStats,
  CombatAction,
  CombatLogEntry,
  TurnResult,
} from "./combat/resolve-turn.js";
export * from "./social/simulator.js";
export { parseGuardedResponse, validateAiBatch } from "./parser/guarded-response.js";
export type { GuardedParseResult, StateDiagnostic } from "./parser/guarded-response.js";
export { StateReceiptFilter, stripStateReceipts } from "./parser/state-receipt.js";
