/** When a variable is "active" (exposed to the AI / rendered in the UI).
 *  Mirrors WorldbookActivation so entries, worldbooks and variables share one
 *  gating model. The variable's VALUE always exists regardless of activation —
 *  conditions, reactions and the sandbox keep reading it by value; activation
 *  only controls exposure (prompt, GamePanel/components) and AI writability.
 *  - always: active whenever the enable gate is on (default).
 *  - manual: no auto-rule; on/off is the enable gate (`enabled` default,
 *    overridden at runtime via ruleState.toggledVariables / @vars.enabled.*).
 *  - conditions: active while variable conditions match (valueRef supported,
 *    so a variable can be bound to another variable).
 *  - greeting: active only in sessions on one of the listed openings
 *    (GameState.activeGreetingId). */
export type VariableActivation =
  | { mode: "always" }
  | { mode: "manual" }
  | { mode: "conditions"; conditions: Condition[]; conditionLogic: "all" | "any" }
  | { mode: "greeting"; greetingIds: string[] };

/** A variable in the game state (e.g., health, gold, relationship score) */
export interface Variable {
  id: string;
  name: string;
  type: "number" | "string" | "boolean" | "json";
  defaultValue: number | string | boolean | Record<string, unknown> | unknown[];
  /** Authoring-only JSON source; runtime uses defaultValue. */
  defaultValueText?: string;
  description?: string;
  min?: number;
  max?: number;
  /**
   * Detailed behavioral instructions for the AI on how to interpret and update this variable.
   * Surfaced to the LLM via the "Variable behavior rules" prompt section.
   */
  behaviorRules?: string;
  /**
   * Legacy alias for `behaviorRules`. Preserved so worlds exported before the rename
   * still import cleanly — loaders fall back to this when `behaviorRules` is empty.
   * New code should always write `behaviorRules`.
   */
  updateHints?: string;
  /**
   * Variable lifecycle scope.
   *   - undefined / "narrative" (default): ordinary game state. Captured in
   *     per-message snapshots and restored on revert/branch/opening-switch.
   *   - "setup": a session-config choice made once at session start (e.g. which
   *     characters the player picked at the pre-game cast screen). It must SURVIVE
   *     operations that replace live state with a stored snapshot — switching the
   *     opening (each opening carries its own snapshot built from world defaults)
   *     and revert/branch. Without this scope the player's pre-game choices get
   *     silently reset to their defaults the moment they pick an opening. See
   *     preserveSetupScopedVariables() in state/setup-scope.ts.
   */
  scope?: "narrative" | "setup";
  /**
   * Engine-managed bookkeeping variable (e.g. the rolling history a random
   * list-pick uses for its cooldown). Persists like any declared variable, but
   * is NEVER rendered into the `<game-state>` prompt block and is hidden from the
   * creator's Variables list so it can't be mistaken for content or deleted.
   * Implies aiAccess "none" regardless of what `aiAccess` says.
   */
  internal?: boolean;
  /**
   * What the AI may do with this variable while it is active.
   *   - undefined / "write" (default): rendered into <game-state>, AI directives
   *     may change it — for state only the AI can judge (affinity, mood).
   *   - "read": rendered into <game-state> with a read-only marker so the AI
   *     narrates it, but AI directives targeting it are dropped — for state the
   *     engine owns (phase, rating, settlement results).
   *   - "none": never rendered into the prompt and never AI-writable — pure
   *     engine/UI state (ledgers, cooldowns, notarization flags).
   * Orthogonal to `activation`; an inactive variable is neither readable nor
   * writable whatever this says.
   */
  aiAccess?: "write" | "read" | "none";
  /** When this variable is active. Undefined = { mode: "always" }. */
  activation?: VariableActivation;
  /** Enable gate default (default true). Runtime overrides live in
   *  ruleState.toggledVariables (set via @vars.enabled.<id> from behaviors),
   *  which beat this field in both directions. Applies to every activation
   *  mode, like a worldbook's master toggle. */
  enabled?: boolean;
}

/** A condition that checks game state */
export interface Condition {
  variableId: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
  /** Right-hand literal. Ignored when `valueRef` is set. */
  value: number | string | boolean | Record<string, unknown> | unknown[];
  /** When set, compare against another variable's current value (by id or
   *  dot-path, e.g. "戒心" or "背包.金币") instead of the literal `value`.
   *  Enables variable-vs-variable conditions. */
  valueRef?: string;
}

/** An audio track that can be played during gameplay */
export interface AudioTrack {
  /** False defers large tracks until playback is requested. */
  preload?: boolean;
  id: string;
  name: string;
  type: "bgm" | "sfx" | "ambient";
  url: string;
  /** False reserves this track for behaviors, playlists and scripts. Defaults to true. */
  allowAiControl?: boolean;
  loop?: boolean;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** When set, auto-stop the track after this many seconds (used as default for all playback paths) */
  maxDuration?: number;
}

/** An audio effect triggered by rules or AI responses */
export interface AudioEffect {
  trackId: string;
  action: "play" | "stop" | "crossfade" | "volume";
  volume?: number;
  fadeDuration?: number;
  /** When set, the specified track will auto-play after this track ends (e.g. SFX → BGM transition) */
  chainTo?: string;
  /** When set, auto-stop the track after this many seconds (with fade) */
  maxDuration?: number;
}

/** Default BGM playlist configuration */
export interface BGMPlaylist {
  tracks: string[];
  playMode: "loop" | "shuffle" | "sequential";
  autoPlay: boolean;
  waitForFirstMessage: boolean;
  gapSeconds: number;
}

/** Trigger type for conditional BGM rules */
export type BGMTriggerType = "variable" | "ai-keyword" | "keyword" | "turn-count" | "session-start";

/** Conditional BGM triggered by game state conditions */
export interface ConditionalBGM {
  id: string;
  name: string;
  triggerType: BGMTriggerType;
  // Variable trigger (existing)
  conditions: Condition[];
  conditionLogic: "all" | "any";
  // Keyword triggers
  keywords?: string[];
  matchWholeWords?: boolean;
  // Turn count trigger
  atTurn?: number;
  everyNTurns?: number;
  // Common fields
  targetTrackId: string;
  priority: number;
  fadeInDuration: number;
  fadeOutDuration: number;
  stopPreviousBGM: boolean;
  fallback: "default" | "previous" | string;
}

/** @deprecated Use TriggerType instead */
export type RuleTrigger = "condition" | "action";

/** @deprecated Use RuleAction with type="notify-player" instead */
export type RuleNotification = "silent" | "always" | "conditional";

/** Effect operation type (reused by modify-variable action) */
export type EffectOperation = "set" | "add" | "subtract" | "multiply" | "toggle" | "append" | "merge" | "push" | "delete";

// ── Rules 2.0: WHEN/IF/THEN ──

/** Trigger types for the WHEN clause */
export type TriggerType = "state-change" | "variable-crossed" | "turn-count" | "session-start" | "keyword" | "ai-keyword" | "action" | "manual" | "every-turn";

/** Configuration for a rule trigger (WHEN) */
export interface TriggerConfig {
  type: TriggerType;
  /** For variable-crossed: which variable to monitor */
  variableId?: string;
  /** For variable-crossed: direction of threshold crossing */
  direction?: "rises-above" | "drops-below";
  /** For variable-crossed: threshold value */
  threshold?: number;
  /** For turn-count: fire at this specific turn */
  atTurn?: number;
  /** For turn-count: fire every N turns */
  everyNTurns?: number;
  /** For keyword / ai-keyword: primary keywords to match */
  keywords?: string[];
  /** For keyword / ai-keyword: match whole words only */
  matchWholeWords?: boolean;
  /** For keyword / ai-keyword: secondary keywords for AND/NOT logic */
  secondaryKeywords?: string[];
  /** For keyword / ai-keyword: logic for secondary keywords */
  secondaryKeywordLogic?: "AND_ANY" | "AND_ALL" | "NOT_ANY" | "NOT_ALL";
  /** For action trigger: the action ID that fires this rule */
  actionId?: string;
}

/** Position for directive injection in the AI's system prompt */
export type DirectivePosition = "auto" | "top" | "before_char" | "after_char" | "bottom" | "depth";

/** Notification style for notify-player action */
export type NotificationStyle = "info" | "achievement" | "warning" | "danger";

/** A single rule action in the THEN clause */
export type RuleAction =
  | { type: "modify-variable"; variableId: string; operation: EffectOperation; value: number | string | boolean | Record<string, unknown> | unknown[]; valueRef?: string }
  | { type: "inject-directive"; directiveId: string; content: string; position?: DirectivePosition; persistent?: boolean; duration?: number }
  | { type: "remove-directive"; directiveId: string }
  | { type: "send-context"; message: string; role?: "system" | "user" }
  | { type: "toggle-entry"; entryId: string; enabled: boolean }
  | { type: "toggle-rule"; ruleId: string; enabled: boolean }
  | { type: "notify-player"; message: string; style?: NotificationStyle }
  | { type: "play-audio"; trackId: string; action: "play" | "stop" | "crossfade" | "volume"; volume?: number; fadeDuration?: number };

/** A rule with WHEN/IF/THEN structure (Rules 2.0) */
export interface Rule {
  id: string;
  name: string;
  description?: string;
  /** WHEN: what event triggers evaluation */
  trigger: TriggerConfig;
  /** IF: conditions that must be true (optional — empty = unconditional) */
  conditions: Condition[];
  conditionLogic: "all" | "any";
  /** THEN: ordered list of actions to execute */
  actions: RuleAction[];
  priority: number;
  /** Minimum turns between firings (undefined = no cooldown) */
  cooldownTurns?: number;
  /** Maximum total times this rule can fire (undefined = unlimited) */
  maxFireCount?: number;
  /** Probability (0-100) the rule fires when it otherwise would (undefined = always) */
  chance?: number;
  /** Whether this rule is active (can be toggled by other rules) */
  enabled: boolean;
}

/** A persistent directive injected into the AI's system prompt */
export interface Directive {
  id: string;
  content: string;
  position: DirectivePosition;
  sourceRuleId: string;
  persistent: boolean;
  injectedAtTurn: number;
  /** Turns until auto-removal (undefined = permanent until explicitly removed) */
  duration?: number;
}

/** Runtime state for the rules system (stored in GameState) */
export interface RuleRuntimeState {
  /** Rule IDs that have been disabled at runtime */
  disabledRules: string[];
  /** Currently active directives injected into AI prompt */
  activeDirectives: Directive[];
  /** ruleId → turn number when cooldown expires */
  cooldowns: Record<string, number>;
  /** ruleId → total times the rule has fired */
  fireCounts: Record<string, number>;
  /** Variable snapshots from previous turn (for variable-crossed detection) */
  prevVars: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
  /** entryId → override enabled state (for toggle-entry action) */
  toggledEntries: Record<string, boolean>;
  /** variableId → override enable-gate state (set via @vars.enabled.<id>).
   *  Beats the variable's `enabled` default in both directions. Optional for
   *  back-compat with persisted pre-upgrade session state — always read with
   *  `?? {}` like toggledEntries. */
  toggledVariables?: Record<string, boolean>;
}

/** An effect that modifies game state */
export interface Effect {
  variableId: string;
  operation: "set" | "add" | "subtract" | "multiply" | "toggle" | "append" | "merge" | "push" | "delete";
  value: number | string | boolean | Record<string, unknown> | unknown[];
  /** Dot-path for nested JSON access (e.g., "factions.ember_court.affinity") */
  path?: string;
  /** When set, the operand is another variable's current value (by id or
   *  dot-path) instead of the literal `value` — e.g. 生命 -= 力量. */
  valueRef?: string;
}

/** @deprecated Use WorldEntry instead */
export interface Character {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  avatar?: string;
  variables: Variable[];
}

// Re-export bundle type
export type { YuminaBundle } from "./bundle.js";

// Re-export component types
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
} from "./components.js";

export { COMPONENT_TYPE_META } from "./components.js";

export type {
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
} from "./ui-blueprint.js";

export type {
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
} from "./ui-package.js";

/** @deprecated Use WorldEntry instead */
export interface LorebookEntry {
  id: string;
  name: string;
  type: "character" | "lore" | "plot" | "style" | "custom";
  content: string;
  keywords: string[];
  conditions: Condition[];
  conditionLogic: "all" | "any";
  priority: number;
  position: "before" | "after";
  enabled: boolean;
  /** Always inject this entry regardless of keyword/condition triggers */
  alwaysSend: boolean;
}

/** A unified content entry — replaces Character + LorebookEntry */
export interface WorldEntry {
  id: string;
  name: string;
  content: string;
  role: "system" | "character" | "personality" | "scenario" | "lore" | "plot" | "style" | "example" | "greeting" | "custom";
  /** The actual API role sent to the LLM. Defaults to "system" if undefined. */
  apiRole?: "system" | "user" | "assistant";
  /** For section="chat-history" only — number of messages from the end to inject */
  depth?: number;
  /** @internal Derived from section via deriveSectionDefaults(). Do not set directly. */
  alwaysSend: boolean;
  keywords: string[];
  conditions: Condition[];
  conditionLogic: "all" | "any";
  enabled: boolean;
  /** Match keywords as whole words only (default false — substring matching) */
  matchWholeWords?: boolean;
  /** Secondary keywords for AND/NOT logic (default []) */
  secondaryKeywords?: string[];
  /** Logic for secondary keywords (default "AND_ANY") */
  secondaryKeywordLogic?: "AND_ANY" | "AND_ALL" | "NOT_ANY" | "NOT_ALL";
  /** If true, this entry's content won't trigger other entries during recursion (default false) */
  preventRecursion?: boolean;
  /** If true, this entry won't be triggered during recursion scans (default false) */
  excludeRecursion?: boolean;
  /** Sort position within its section (ascending: lower = first). Allows floats for insertion (e.g. 2.5 between 2 and 3). */
  position: number;
  /** Which section this entry belongs to — determines delivery zone */
  section: "system-presets" | "examples" | "chat-history" | "post-history";
  /** User-facing tags for organization (e.g., ["Character", "Plot"]) */
  tags?: string[];
  /** ID of the folder this entry belongs to (within its section) */
  folderId?: string;
  /** Links to an official preset. Undefined for regular entries. */
  presetId?: string;
  /** Install-id of the bundle this entry came from (see WorldDefinition.installedBundles).
   *  Undefined for user-authored entries. Powers per-bundle color-coding + clean removal. */
  bundleInstallId?: string;
  /** Who receives this entry's content: AI prompt, player UI slots, or both (default). */
  audience?: "ai" | "player" | "both";
  /** Character portrait shown beside this character's lines in chat. An
   *  `@asset:<id>` reference (or an absolute URL). Only meaningful on
   *  `role: "character"` entries. */
  portrait?: string;
  /**
   * When true, this entry is active only while variable conditions match
   * (replaces manual enabled / always-send toggles in the editor).
   */
  variableBound?: boolean;
  /** Links paired entries (e.g. AI summary + player full text) for editor navigation. */
  pairId?: string;
  /** Which worldbook (lore module) this entry belongs to. Undefined = the
   *  implicit always-on "Core" worldbook. Orthogonal to `section` (which still
   *  decides the prompt delivery zone). See WorldDefinition.worldbooks. */
  worldbookId?: string;
  /** For role="greeting" entries only: variables to seed into session state when
   *  this opening is chosen. Powers "scenario / route presets" — picking an
   *  opening activates the matching worldbook(s) + frontend view via these vars. */
  initialVariables?: Record<string, number | string | boolean>;
}

/** Binds a Custom UI LoreSlot placeholder to a lorebook entry + optional extra conditions. */
export interface LoreUiBinding {
  slotId: string;
  entryId: string;
  conditions: Condition[];
  conditionLogic: "all" | "any";
}

/** When a worldbook (lore module) is "online" and its entries become eligible.
 *  - always: on whenever the book is enabled.
 *  - conditions: on when variable conditions match.
 *  - manual: no auto-rule; on/off is the `enabled` toggle (set by the creator
 *    or, at runtime, by the card's frontend). */
export type WorldbookActivation =
  | { mode: "always" }
  | { mode: "manual" }
  | { mode: "conditions"; conditions: Condition[]; conditionLogic: "all" | "any" }
  /** Active only when the current opening (greeting) is one of the listed IDs.
   *  The chosen opening is tracked in the first-class `GameState.activeGreetingId`
   *  field, so this mode works as a pure function of game state — revert/branch safe. */
  | { mode: "greeting"; greetingIds: string[] };

/** A worldbook = an activatable module of lorebook entries (its own presets,
 *  examples, lore, post-history). A card can hold several; the active set is a
 *  pure function of game state (variables/conditions), so it is revert-safe and
 *  needs no client round-trip. Membership is by WorldEntry.worldbookId. */
export interface Worldbook {
  id: string;
  name: string;
  description?: string;
  /** Master enable toggle (default true). When false the whole book is off,
   *  regardless of its activation rule. */
  enabled?: boolean;
  activation: WorldbookActivation;
  /** Sort/precedence order in the editor. */
  order: number;
  /** Editor color (Tailwind class), optional. */
  color?: string;
  /** Install-id if this worldbook came from a bundle (future: worldbook ≡ bundle). */
  sourceBundleId?: string;
}

/** @deprecated Use CustomUIComponent with surface field instead */
export interface CustomComponent {
  id: string;
  name: string;
  tsxCode: string;
  description: string;
  order: number;
  visible: boolean;
  updatedAt: string;
}

/** @deprecated — v1 custom UI component. Every world is migrated to
 *  `rootComponent` via migrateV19ToV20, which clears this array. The type is
 *  kept temporarily so legacy_schema_backup restoration and editor scaffolding
 *  still compile; runtime code must not consume it. Remove the type entirely
 *  in a follow-up once editor + import/export paths are v2-native. */
export interface CustomUIComponent {
  id: string;
  name: string;
  /** @deprecated No meaning in v2 — every world uses rootComponent. */
  surface: "message" | "app";
  language: "tsx" | "html" | "markdown";
  tsxCode: string;
  description: string;
  order: number;
  visible: boolean;
  updatedAt: string;
}

// ── Root Component ─────────────────────────────────────────────────

/** State channels for partitioned state delivery in root component worlds */
export type StateChannel = "variables" | "messages" | "streaming" | "session" | "ui";

/** The root visual component for a world — multi-file virtual file system */
export interface RootComponent {
  id: string;
  name: string;
  /** Entry point file name (e.g. "index.tsx") */
  entryFile: string;
  /** Virtual file system: filename → TSX source code */
  files: Record<string, string>;
  updatedAt: string;
  /** Pre-compiled JS stamped at save-time; skips the play-time recompile when
   *  filesHash + compilerVersion still match. Falls back to a fresh compile. */
  compiled?: {
    code: string;
    filesHash: string;
    compilerVersion: number;
  };
}

/** A folder for organizing entries within one worldbook section (purely UI, not sent to AI). */
export interface EntryFolder {
  id: string;
  name: string;
  section: "system-presets" | "examples" | "chat-history" | "post-history";
  order: number;
  collapsed?: boolean;
  /** Which knowledge base owns this folder. Undefined = the Main/Core book. */
  worldbookId?: string;
}

/** Record of a bundle imported into this world. Powers per-bundle color-coding
 *  in the editor and the "Manage Bundles" panel (list + clean removal). Created
 *  by the editor's importBundle action; not consumed by the runtime. */
export interface InstalledBundle {
  /** Unique per import (crypto.randomUUID()). Tagged onto each imported entry via bundleInstallId. */
  installId: string;
  /** Source hub bundle id, when the import originated from a known bundle. */
  sourceBundleId?: string;
  name: string;
  /** `_bundles/{slug}/` rootComponent folder, present only when the bundle shipped UI. */
  slug?: string;
  /** Key into the editor's BUNDLE_COLOR_PALETTE. Stable across reloads. */
  colorKey: string;
  /** ISO timestamp of import. */
  importedAt: string;
  /** Deterministic hash of the imported content at import time — used to detect
   *  whether the user has since modified the bundle's content (extra delete warning). */
  originalHash: string;
  /** IDs of the content this bundle added, for clean removal. */
  entryIds: string[];
  variableIds: string[];
  ruleIds: string[];
  /** IDs of behaviors this bundle added (absent on records written before
   *  bundles carried reactions). */
  reactionIds?: string[];
  audioTrackIds: string[];
  folderIds: string[];
  /** IDs of worldbooks this bundle added (optional — absent on pre-worldbook records). */
  worldbookIds?: string[];
}

/** Image crop used by Hub cards and gallery previews. */
export interface CoverCropSettings {
  x: number;
  y: number;
  zoom: number;
  fit?: "cover" | "contain";
}

/** The full World definition — the complete game package */
export interface WorldDefinition {
  id: string;
  version: string;
  /** BCP 47 language code (e.g., "en", "zh", "ja"). For multi-language linking. */
  language?: string;
  name: string;
  description: string;
  author: string;
  /** @deprecated Use worlds.thumbnailUrl DB column instead. This field is unused for display. */
  avatar?: string;
  /** Crop framing for the Hub card cover. */
  coverCrop?: CoverCropSettings;
  /** Crop framing for the cover when it appears as a gallery preview image. */
  galleryCoverCrop?: CoverCropSettings;
  entries: WorldEntry[];
  variables: Variable[];
  rules: Rule[];
  /** Generic reactions (extensible event-driven rules). Evaluated alongside legacy rules. */
  reactions?: import("../events/types.js").Reaction[];
  /** Which systems this world uses (determines available events in editor). Default: core systems only. */
  systems?: string[];
  /** Scenes for the spatial system — grid-based areas with zones, entities, and exits */
  scenes?: import("../spatial/types.js").Scene[];
  /** @deprecated Use entries instead */
  characters?: Character[];
  components: import("./components.js").GameComponent[];
  uiBlueprint?: import("./ui-blueprint.js").UIBlueprint;
  audioTracks: AudioTrack[];
  bgmPlaylist?: BGMPlaylist;
  conditionalBGM?: ConditionalBGM[];
  /** @deprecated Use entries instead */
  lorebookEntries?: LorebookEntry[];
  /** @deprecated v1 surface-based custom UI. Migrated into rootComponent by
   *  migrateV19ToV20 — always empty array after migration. Kept in the type
   *  for transient reads (e.g. legacy_schema_backup restoration) but MUST NOT
   *  be read by runtime code. Remove from type in a future pass once all
   *  import/export paths are confirmed clean. */
  customUI: CustomUIComponent[];

  /** Root React component — multi-file virtual filesystem. Present for every
   *  world after v19→v20 migration. This is the ONLY visual-layer input the
   *  runtime reads. */
  rootComponent?: RootComponent;

  /** User-defined tag names beyond the defaults */
  customTags?: string[];
  /** Map of custom tag name → Tailwind color class (e.g. "bg-rose-400/40") */
  customTagColors?: Record<string, string>;
  /** Folders for organizing entries within sections */
  entryFolders?: EntryFolder[];
  /** LoreSlot → entry bindings (Studio Custom UI → Bindings tab). */
  loreUiBindings?: LoreUiBinding[];
  /** Worldbooks (lore modules) for composing a card into multiple activatable
   *  worlds/routes/scenes. Entries reference one via WorldEntry.worldbookId;
   *  entries with no worldbookId belong to the implicit always-on Core book. */
  worldbooks?: Worldbook[];
  /** Bundles imported into this world — registry for color-coding + Manage Bundles. */
  installedBundles?: InstalledBundle[];
  /** Which editor UI to use: "simple" (Quick Create) or "advanced" (full editor) */
  editorMode?: "simple" | "advanced";
  settings: WorldSettings;
}

/** World-level settings — generation parameters are optional (global user config takes priority) */
export interface WorldSettings {
  /** Max response tokens (optional — global config takes priority, default 12000) */
  maxTokens?: number;
  /** Max context window size for history trimming (default 200000) */
  maxContext?: number;
  /** Temperature (optional — global config takes priority, default 1.0) */
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  topK?: number;
  minP?: number;
  /** Player display name for {{user}} macro (default "User") */
  playerName?: string;
  /** @deprecated Use an entry with role="system" + position="top" */
  systemPrompt?: string;
  /** @deprecated Use an entry with role="greeting" + position="greeting" */
  greeting?: string;
  /** @deprecated Use lorebookBudgetPercent instead */
  lorebookTokenBudget?: number;
  /** @deprecated Token budgets removed — all triggered entries are included */
  lorebookBudgetPercent?: number;
  /** @deprecated Token budgets removed — all triggered entries are included */
  lorebookBudgetCap?: number;
  /** Number of recent messages to scan for keyword matches (default 2) */
  lorebookScanDepth?: number;
  /** Max recursion depth for cascading entry triggers. 0 = disabled (default 0). Range 0-10. */
  lorebookRecursionDepth?: number;
  /** @deprecated Use uiMode instead */
  layoutMode?: "split" | "game-focus" | "immersive";
  /** @deprecated No longer used — layout is automatic based on world content */
  uiMode?: "chat" | "per-reply" | "persistent";
  /** When true, request JSON structured output from the LLM via response_format */
  structuredOutput?: boolean;
}

/** Runtime game state during a play session */
export interface GameState {
  worldId: string;
  variables: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
  /** @deprecated No longer used — character identity is now an entry */
  activeCharacterId?: string | null;
  /** The opening (greeting entry id) this session/branch is on. A first-class,
   *  normalization-preserved session fact (NOT a declared variable — undeclared
   *  variable keys are stripped by GameStateManager.normalizeState). Worldbooks
   *  with activation.mode="greeting" key off this. Set at session creation and
   *  when the player switches openings on the first message; rides the per-message
   *  stateSnapshot so revert/branch restore it. */
  activeGreetingId?: string | null;
  turnCount: number;
  metadata: Record<string, unknown>;
  /** Rules 2.0 runtime state (initialized on first use for backward compat) */
  ruleState?: RuleRuntimeState;
}
