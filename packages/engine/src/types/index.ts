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
   * Fixed set of values a string variable may take. When present the editor
   * offers precise tracking (the value is picked from this list, never written
   * freely). Ignored for other types.
   */
  options?: string[];
  /**
   * Precise tracking ("精准追踪"): after each reply the continuity judge, not
   * the narrative model, decides this variable's new value. Numbers need
   * `deltaDown`/`deltaUp`; strings need `options`; booleans need nothing.
   * See engine/src/continuity.
   */
  precise?: boolean;
  /** Largest decrease the judge may apply in one turn (number vars, ≥ 0). */
  deltaDown?: number;
  /** Largest increase the judge may apply in one turn (number vars, ≥ 0). */
  deltaUp?: number;
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
  /**
   * 公式数值: a number the engine works out from other variables after every
   * change (state/formula.ts) — `基础攻击 + 武器.攻击 * (1 + 等级 * 0.1)`,
   * `min(存活, 40 - len(死者))`. Names are variable names or ids; `{a-b}`
   * quotes one with symbols in it. The AI reads it but never writes it.
   */
  formula?: string;
  /**
   * 跨存档保留: "player" keeps this value for the player across every
   * playthrough of the card (clears, unlocked endings, collected CGs). A new
   * session starts from the saved value instead of the default.
   */
  persist?: "player";
  /** When this variable is active. Undefined = { mode: "always" }. */
  activation?: VariableActivation;
  /** Enable gate default (default true). Runtime overrides live in
   *  ruleState.toggledVariables (set via @vars.enabled.<id> from behaviors),
   *  which beat this field in both directions. Applies to every activation
   *  mode, like a worldbook's master toggle. */
  enabled?: boolean;
  /**
   * Author permission for the optional Lore Shift extension. When true, a
   * player may change this primitive value for their current session only.
   * Missing/false fails closed and never affects normal card-authored UI,
   * rules, reactions, or effects.
   */
  liveCanonEditable?: boolean;
  /** Which worldbook (module) this variable belongs to. Undefined = the
   *  implicit always-on Core module. When the module is inactive the variable
   *  is inactive too (ANDed with its own activation/enable gates); its VALUE
   *  still exists — module membership only gates exposure, like activation.
   *  Unknown ids fail open (mirrors WorldEntry.worldbookId). */
  worldbookId?: string;
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

/** World-level switches for the continuity judge. */
export interface ContinuityConfig {
  /** Master switch (default true). Off = the judge never runs for this world. */
  enabled?: boolean;
  /** Opt-out for BGM picking: tracks with an `aiNote` are in the pool unless this is false. */
  bgm?: boolean;
  /** Opt-out for one-shot SFX: tracks with an `aiNote` are in the pool unless this is false. */
  sfx?: boolean;
  /** Opt-out for scene images: by default the judge picks one from `sceneImages`
   *  by their `scene` cue and the narrating model is not told about them.
   *  false = the narrating model places them itself with `[image: id]`. */
  images?: boolean;
  /** Author's music rules for the judge's picks. Each is a choice the author
   *  makes on the Audio page, not a platform constant. */
  music?: ContinuityMusicConfig;
}

export interface ContinuityMusicConfig {
  /** When a conditional-BGM rule is active: false (default) = the rule keeps
   *  the channel and the judge waits; true = the judge's pick takes over and
   *  rules stay out until that pick ends or is handed back. */
  overRules?: boolean;
  /** What happens after a judge-picked track: false (default) = it loops
   *  until the judge switches or hands back; true = it plays once and the
   *  default playlist resumes when it ends. */
  once?: boolean;
  /** Dip BGM/ambient while a judge-picked sound effect plays (default true). */
  duck?: boolean;
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
  /** "What to play this for" — the author's one-line cue. A track with a cue
   *  joins the continuity judge's pool (see WorldDefinition.continuity). */
  aiNote?: string;
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
  /** Set on effects the continuity judge produced. The player treats them as
   *  the lowest-priority music source: a conditional-BGM rule that is active
   *  keeps its track (the judge's crossfade is ignored), a judge crossfade only
   *  stops BGM the AI is allowed to control, and a judge `stop` hands the music
   *  back to the default playlist. */
  source?: "continuity";
  /** Lower BGM/ambient while this one-shot plays; restored when it ends. */
  duckBgm?: boolean;
  /** Override the track's own loop setting for this playback. */
  loop?: boolean;
  /** Judge crossfade only: the author chose "AI over rules" — take the
   *  channel even while a conditional rule is active and keep rules out
   *  until this pick ends or is handed back. */
  overRules?: boolean;
  /** When set, the specified track will auto-play after this track ends (e.g. SFX → BGM transition) */
  chainTo?: string;
  /** When set, auto-stop the track after this many seconds (with fade) */
  maxDuration?: number;
}

/** An author-registered scene image the AI can show mid-narrative with `[image: id]` */
export interface SceneImage {
  /** Short handle the AI writes in the directive, e.g. `img1`. */
  id: string;
  name: string;
  /** `@asset:{uuid}` or an https URL. */
  url: string;
  /** When to show it — this sentence is what the AI reads. */
  scene: string;
  /** Player-facing teaser for the locked gallery slot. */
  hint?: string;
  /** Restrict to these openings (greeting entry ids). Empty/absent = every opening. */
  greetingIds?: string[];
  /** False keeps the image out of the AI's list (author triggers it manually). Defaults to true. */
  allowAiControl?: boolean;
}

/** Sentinel `url` meaning "whatever the card's cover is right now". Kept as a
 *  sentinel rather than copying the cover URL so a later cover change carries. */
export const COVER_BACKGROUND_URL = "@cover";

/** A picture painted behind the whole chat.
 *
 *  Twin of SceneImage: same id/name/url/scene/greetingIds shape, different
 *  destination — a scene image lands inside a message, a background sits
 *  behind everything. The extra fields are the treatment, which is not
 *  optional in practice: a photograph directly behind body text is unreadable,
 *  so every background carries the blur and dim that make it a backdrop. */
export interface BackgroundImage {
  /** Short handle the AI and behaviours write, e.g. `bg1`. */
  id: string;
  name: string;
  /** `@asset:{uuid}`, an https URL, or COVER_BACKGROUND_URL. */
  url: string;
  /** When to show it — the sentence the AI reads. Empty means the AI never
   *  picks this one; an opening, a behaviour or the default flag does. */
  scene?: string;
  /** Gaussian blur in px, 0–20. Applied to the picture, never as a
   *  backdrop-filter over the scrolling transcript. */
  blur?: number;
  /** Black overlay percentage, 0–80. What actually buys legibility. */
  dim?: number;
  /**
   * How opaque the picture itself is, 10–100. Not the same knob as `dim`:
   * dim lays BLACK over the whole area, so everything tends to black, while
   * this fades the picture into whatever the card's own theme paints behind
   * it. On a dark card the two look alike; on a light one dim turns the
   * picture grey and this keeps it in the card's own tone. Use dim for
   * legibility, this for how much of the picture you want at all.
   *
   * Floored at 10 rather than 0: a background dragged to nothing looks
   * broken, and "I do not want one" is a delete, not a slider.
   */
  opacity?: number;
  /** Which part of a tall picture survives the crop. */
  position?: "center" | "top" | "bottom";
  /** Restrict to these openings (greeting entry ids). Empty/absent = every one. */
  greetingIds?: string[];
  /** False keeps it out of the AI's list. Defaults to true. */
  allowAiControl?: boolean;
  /** The one shown before anything chooses. At most one per card wins; when
   *  several claim it the first in document order does. */
  isDefault?: boolean;
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
  /** Which worldbook (module) this rule belongs to. Undefined = Core (always
   *  on). Rules of an inactive module are skipped by the reaction runner.
   *  Unknown ids fail open (mirrors WorldEntry.worldbookId). */
  worldbookId?: string;
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
  /** worldbookId → whether the module is switched on, for the activation
   *  modes that have no automatic rule of their own (`manual`, `keywords`).
   *  Beats the module's `enabled` default. Optional for back-compat with
   *  persisted pre-upgrade session state — always read with `?? {}`, like
   *  toggledEntries. */
  toggledWorldbooks?: Record<string, boolean>;
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
  /** A moving portrait: short clips (`@asset:` refs) that replace the still
   *  one where a renderer can play video. `idle` loops while the character is
   *  on screen; `speaking` plays while their line is being written, then the
   *  idle loop returns. Either may be absent. */
  portraitVideo?: { idle?: string; speaking?: string };
  /** The voice this character's lines are read in: a fish.audio reference id
   *  (32 hex). Set by the author; the player's own voice choice yields to it.
   *  Only meaningful on `role: "character"` entries. */
  voice?: string;
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
  /**
   * Author permission for session-local lore overrides. Version 1 deliberately
   * permits content replacement only; every delivery/authority field remains
   * owned by the author. Missing values are locked.
   */
  sessionEditPolicy?: "locked" | "content";
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
  | { mode: "greeting"; greetingIds: string[] }
  /**
   * Switched on by something the player says, and it STAYS on.
   *
   * A keyword is a door, not a spotlight. Matching the way lore entries match
   * — on only while the word is still in the recent window — would close the
   * dungeon the moment the player stopped saying its name, which is not a
   * thing anyone wants to build. So the match is a latch: the hit writes
   * `ruleState.toggledWorldbooks`, and the gate below reads that. Activation
   * stays a pure function of game state, which is what makes it revert-safe;
   * the scan is a state WRITER, exactly like a reaction.
   *
   * `exclusive` is what makes this a switch rather than an accumulator: when
   * this module's word lands, every other exclusive keyword module goes dark.
   * That is "walk out of dungeon A into dungeon B", which is the thing this
   * mode exists for.
   */
  | { mode: "keywords"; keywords: string[]; exclusive?: boolean;
      /** Words that walk the player back out: "回店里" closes 后仓. Without
       *  them a keyword module stayed open until some other exclusive one
       *  opened, so its settings kept going to the AI after the player left. */
      leaveKeywords?: string[] };

/**
 * 模块总控 — everything that makes a module an AI station.
 *
 * A card used to be one AI whose prompt was gated by modules; a module was a
 * folder. A station makes the module the AI: its own model, its own context,
 * its own lifecycle. Several stations on one card is several AIs cooperating
 * on one game — a dungeon's narrator, the next dungeon's narrator, and a
 * background chronicler that reads the first and briefs the second.
 *
 * Absent `station` = a plain content module: today's behaviour, which is what
 * every existing card has. Its entries and variables join the one narrator's
 * prompt and nothing else changes. That default is the back-compat guarantee.
 */
export interface ModuleStation {
  /** narrator — this module's AI answers the player while the module is active.
   *  worker  — never speaks to the player; runs on a trigger and produces
   *            context for other modules to drink. */
  kind: "narrator" | "worker";
  /** Model for this station's turns. Falls back to the session's model when
   *  absent, and when the player's plan or keys cannot reach it — a card may
   *  ask for a model, never force one onto someone who cannot run it. */
  model?: string;
  /** What this station can see, in the order it is injected. */
  inputs?: ModuleContextInput[];
  /** narrator only — while this module answers, it reads at most this many
   *  recent messages. Wins over the card's settings.historyLimit. */
  historyLimit?: number;
  /**
   * narrator only — which part of the transcript this AI remembers.
   *
   * "shared" (the default): the whole conversation, the way every card has
   * always worked. Dungeon A and the town share one memory.
   *
   * "own": only the messages spoken while THIS module was active — its own
   * runs, past and present — plus whatever `inputs` wire in. Walk into the
   * tower and the AI there has never heard of the town; walk out, and the
   * town's narrator remembers the tower (the messages never left the
   * transcript, only this module's view of it was narrow). That is a run
   * boundary, so a module with "own" memory is run-tracked whether or not
   * it archives on close.
   *
   * Superseded by `memoryPool`: "own" is a pool of one. Read for cards that
   * set it; new writes name a pool.
   */
  history?: "shared" | "own";
  /**
   * narrator only — which memory this AI shares.
   *
   * Absent: the card's own pool, the whole conversation, the way every card
   * has always worked. Named: every narrator naming the same pool remembers
   * each other's runs and nothing spoken outside them. "A and B share one
   * memory, C and D another" is two names. A pool of one is the tower: an AI
   * that has never heard of the town. Messages never leave the transcript —
   * a pool is a view, and the card's own narrator still sees everything.
   */
  memoryPool?: string;
  /**
   * What happens to this station's own span when the module deactivates.
   *
   * "archive" (the default for a station): the span leaves the AI's context
   * and is replaced by one generated summary, while the player's transcript
   * keeps every word. A module IS a run — re-activation starts clean. This is
   * the infinite-flow wipe, and it is a property of being a station rather
   * than a toggle of its own.
   *
   * "keep": the span stays in context like ordinary history.
   */
  onClose?: "archive" | "keep";
  /** Extra instruction for the summariser that archives a closed span
   *  ("记录死因、拿到的线索和欠下的人情"). */
  archivePrompt?: string;
  /** worker only — when it runs. */
  trigger?: WorkerTrigger;
  /** worker only — the task, in the creator's words. The module's own entries
   *  are its system prompt; this is the job it is being asked to do. */
  task?: string;
  /** What the creator calls this AI on the canvas (「老板娘」, 「记录」).
   *  Display only; absent, the situation's name stands in. */
  name?: string;
  // ── Custom (自定义) — what a card's hand-written AI calls do, as data. ──
  // Read by the ai-call runner (server lib/ai-call.ts): the card's screen
  // calls the AI with `api.callAi(name, input)` and gets the result back.
  /** What it sees besides the card's always-sent lore and its own entries. */
  sees?: AiSees;
  /** Prompt pieces added only while their conditions hold
   *  (「好感度 ≥ 60：语气更亲近」). */
  pieces?: AiPromptPiece[];
  /** The answer's shape. Absent or empty: plain text. With fields, the AI
   *  answers one JSON object and each field goes where it is routed. */
  output?: AiOutputField[];
  /** Where its words go: "story" (a message in the chat, the default), "none"
   *  (only returned to the card), or any other string — an interface channel
   *  the card listens to with `api.onAiOutput`. */
  say?: string;
  /** What happens when the model is slow or answers in the wrong shape. */
  onError?: AiOnError;
  /** Seconds before it may be called again. */
  cooldownSec?: number;
  /** Most tokens one answer may take (default 800). */
  maxTokens?: number;
}

export interface AiSees {
  /** Variables whose current values it is shown. */
  variables?: string[];
  /** How many recent chat messages it reads (0: none). */
  history?: number;
  /** Its own past calls and answers, a thread of its own (each phone
   *  contact, each Godot character), kept per session. */
  ownThread?: boolean;
}

export interface AiPromptPiece {
  conditions: Condition[];
  conditionLogic?: "all" | "any";
  text: string;
}

export type AiOutputRoute =
  /** Spoken: this field is the AI's words, sent where `say` points. */
  | { kind: "say" }
  /** Written into a variable: set, add (numbers) or push (lists). */
  | { kind: "variable"; variableId: string; op?: "set" | "add" | "push" }
  /** Sets off a story event of this name (the field's value when absent),
   *  which behaviours and `api.onStoryEvent` hear. */
  | { kind: "event"; name?: string };

export interface AiOutputField {
  name: string;
  type: "text" | "number" | "choice" | "list";
  /** choice: the only answers allowed. list: allowed items (optional). */
  options?: string[];
  /** number: clamped into this range. */
  min?: number;
  max?: number;
  /** What the field means, for the model. */
  hint?: string;
  to?: AiOutputRoute;
}

export interface AiOnError {
  /** Seconds to wait for the model (default 25). */
  timeoutSec?: number;
  /** Retries when the answer is not the asked shape (default 1). */
  retries?: number;
  /** Lines to use, one picked at random, when every try failed. */
  fallback?: string[];
  /** When every try failed, answer the fields anyway: a random allowed
   *  option for each choice (a legal move), the low end for numbers, an
   *  empty list. For AI opponents that must always move. */
  randomChoice?: boolean;
}

/** Where a station's context comes from. `from` is a worldbook id, or `"*"`
 *  for "every module that does this" — every archiving module for `memory`,
 *  every other worker for `worker`. The wildcard is what makes a head
 *  archivist one wire instead of twenty-one; `transcript` and `variables`
 *  do not take it (see ANY_MODULE).
 *
 *  `as` decides how the block reads to the receiving AI: "history" is the
 *  protagonist's lived past, "lore" is an archive consulted about someone.
 *  A chronicler's briefing is usually "lore"; carrying your own memories out
 *  of dungeon 1 into dungeon 2 is "history". */
export type ModuleContextInput =
  /** Another module's archived spans — its finished runs. */
  | { kind: "memory"; from: string; as?: "history" | "lore"; limit?: number }
  /** A worker module's most recent outputs. */
  | { kind: "worker"; from: string; as?: "history" | "lore"; limit?: number }
  /** A snapshot of another module's variables, rendered as one block. */
  | { kind: "variables"; from: string; as?: "history" | "lore" }
  /** Another module's raw transcript, most recent N messages. The honest but
   *  expensive input — a long dungeon will not fit, so `limit` is required
   *  and capped. */
  | { kind: "transcript"; from: string; limit: number; as?: "history" | "lore" };

/** When a worker station runs. */
export type WorkerTrigger =
  /** The classic: a dungeon finishes, the chronicler writes it up. `from` is
   *  that dungeon's id, or `"*"` for whichever module just closed — one
   *  chronicler serving a card with twenty-two dungeons instead of
   *  twenty-two near-identical modules. It runs once per module closed, and
   *  `cause` carries which one, so the worker's own prompt can name it. */
  | { on: "module-closed"; from: string }
  /** Any game-state condition — the same shape module activation uses. */
  | { on: "conditions"; conditions: Condition[]; conditionLogic?: "all" | "any" }
  /** Every N player turns. */
  | { on: "turns"; every: number }
  /** Right after the AI of module `from` has answered the player: a recorder
   *  that writes up each of one character's replies, a critic that reads what
   *  the narrator just said. A turn answered by anyone else does not wake it. */
  | { on: "after"; from: string }
  /** When nothing has happened for this many seconds — no player message, no
   *  reply, no earlier interjection — while this module is active. Unlike the
   *  others, its answer goes into the story itself: a line of narration (it
   *  may change values) or nothing, if nothing is worth saying. The player's
   *  open game drives the clock, so it only runs while someone is playing. */
  | { on: "quiet"; seconds: number }
  /** When the player's screen calls it — a button on the card's interface
   *  (ui-doc action `run-ai`, or `api.callAi(id)` from card code). It answers
   *  into the story the way a quiet station does: a line, values, or nothing. */
  | { on: "ui" };

/** @deprecated Legacy shape, superseded by ModuleStation.inputs `{kind:"memory"}`.
 *  Read at load for cards authored before the station model; never written. */
export interface WorldbookMemorySubscription {
  sourceBookId: string;
  as?: "history" | "lore";
  limit?: number;
}

/** A worldbook = an activatable module of lorebook entries (its own presets,
 *  examples, lore, post-history). A card can hold several; the active set is a
 *  pure function of game state (variables/conditions), so it is revert-safe and
 *  needs no client round-trip. Membership is by WorldEntry.worldbookId. */
export interface Worldbook {
  id: string;
  name: string;
  description?: string;
  /** The sticky note (便签): a creator-facing working memo pinned to this
   *  module — design intent, TODOs, "this dungeon wipes on exit". Read by the
   *  creator AND the studio AI (it appears in the world snapshot), so it is
   *  the shared blackboard between them. Never enters the PLAY prompt: it is
   *  a blueprint annotation, not lore. */
  note?: string;
  /** The file in `rootComponent.files` that is this module's scene — what the
   *  card's interface shows while the module is on. Tooling only (the
   *  blueprint previews and opens it; the studio AI reads it): at play time
   *  the entry file does its own routing, usually on the same variable the
   *  module's activation reads. */
  frontendFile?: string;
  /** Master enable toggle (default true). When false the whole book is off,
   *  regardless of its activation rule. */
  enabled?: boolean;
  activation: WorldbookActivation;
  /**
   * 模块总控 — present when this module is an AI station rather than a plain
   * content container. One field holds the whole thing: which kind of station,
   * its model, what context flows in, what happens to its span when it closes,
   * and (for a worker) when it runs and what it is for.
   *
   * Absent is the default and the back-compat guarantee: the module behaves
   * exactly as modules always have.
   */
  station?: ModuleStation;
  /**
   * Where an AI lives — read only on a book with a `station`. "card": on the
   * card itself, in play whenever the card is. A situation's id: in that
   * situation, in play while it is on. "unplaced": added but not put anywhere,
   * so never in play. Absent is the older shape, where a situation with a
   * station IS the AI and its own activation decides.
   */
  host?: string;
  /** On a situation whose AIs answer the player: the card's own narrator
   *  stays and talks here too, as one more voice. Off, the situation's AIs
   *  answer instead of it. */
  narratorHere?: boolean;
  /** @deprecated Superseded by `station`. Read once at load and normalised
   *  away (see resolveStation); never written. Kept because stored cards
   *  outlive the types that described them — a card exported before the
   *  station model still has to open. */
  runScoped?: boolean;
  /** @deprecated Superseded by `station.archivePrompt`. */
  runSummaryPrompt?: string;
  /** @deprecated Superseded by `station.inputs` entries of kind "memory". */
  memorySubscriptions?: WorldbookMemorySubscription[];
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
  /**
   * Set when these files are the OUTPUT of `WorldDefinition.uiDoc` rather than
   * something a person wrote. Save-time regenerates them from the doc without
   * asking; absent, the files are hand-written and the visual editor must get
   * an explicit, irreversible confirmation before it takes the surface over.
   *
   * Every card written before the interface builder existed is missing this
   * field, so the cautious branch is the default one — which is the right way
   * round. Compiling TSX back into a document is not possible, and a silent
   * overwrite of someone's 300KB frontend is not a mistake you can apologise
   * for afterwards.
   */
  generatedFrom?: "uiDoc";
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
  /** Separate landscape artwork for wide Discover placements. */
  landscapeCover?: string;
  landscapeCoverCrop?: CoverCropSettings;
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
  /** Scene images the AI may surface with `[image: id]` — see SceneImage. */
  sceneImages?: SceneImage[];
  /** Pictures painted behind the chat — see BackgroundImage. */
  backgrounds?: BackgroundImage[];
  bgmPlaylist?: BGMPlaylist;
  conditionalBGM?: ConditionalBGM[];
  /** Continuity judge ("场记" internally, "智能追踪" to authors): after each
   *  reply a decision model updates precise-tracked variables and picks music,
   *  sound effects and scene images from the author's cues. Missing = enabled
   *  for variables, pools off. See engine/src/continuity. */
  continuity?: ContinuityConfig;
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

  /**
   * The card's interface as a document — what the drag editor and the Studio
   * agent both edit. The runtime never reads this: save-time compiles it into
   * `rootComponent` (see ui-doc/compile.ts), so there is one renderer and one
   * contract, and every downstream consumer keeps working unchanged.
   */
  uiDoc?: import("../ui-doc/types.js").UiDoc;

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
  /** Canvas-only persisted layout (node coords/collapse/notes). Additive; the
   *  runtime and form editor ignore it. Absent on cards never opened in canvas. */
  graphLayout?: import("../graph/types.js").GraphLayout;
  /** 回复处理: rules that take tagged blocks out of the AI's reply — into
   *  variables, a story event, an interface channel; hidden or not
   *  (parser/reply-rules.ts). */
  replyRules?: import("../parser/reply-rules.js").ReplyRule[];
  settings: WorldSettings;
}

/** World-level settings — generation parameters are optional (global user config takes priority) */
export interface WorldSettings {
  /** The default chat splits one reply into a bubble per speaker when lines
   *  open with a character's name (「沈霏：…」). Off by default. */
  speakerBubbles?: boolean;
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
  /** The voice narration is read in (fish.audio reference id). A speaking
   *  character without a voice of their own is read in this one too. */
  narratorVoice?: string;
  /** What happens when the player lets go of the mic (hold-to-talk voice
   *  input): "confirm" fills the composer for review, "auto" sends it as
   *  spoken. The player can override it. Absent = "confirm". */
  voiceInputMode?: "confirm" | "auto";
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
  /** Author-set history window: the story AI reads only the latest N messages
   *  of the current run. Undefined = everything the token budget allows. */
  historyLimit?: number;
  /** Whose context budget a send honours. "player" (default): the player's
   *  per-send override wins. "author": this card's maxContext wins; the plan
   *  cap and the model window still clamp it. */
  contextPolicy?: "player" | "author";
  /**
   * Author-side story memory (Context → 摘要 + 最新 N 条). When on, the turns
   * that have left the window are not simply gone: the server keeps a rolling
   * "story so far" summary of them and sends it ahead of the raw history, the
   * same machinery the player-side memory extension uses, switched on by the
   * card for every player. `focus` is the author's one line to the summariser
   * about what must survive compression (「记住人物关系、承诺和欠的债」).
   */
  storySummary?: { enabled: boolean; focus?: string };
  /**
   * A line the author pins near the end of the history every turn — the
   * author's note. `depth` counts messages from the end (1 = right before
   * the newest message, 0 = after it); default 1. Delivered through the same
   * channel as a chat-history entry with a depth, without being an entry the
   * lorebook lists.
   */
  pinnedNote?: { content: string; depth?: number; apiRole?: "system" | "user" | "assistant" };
  /**
   * How the current variable values reach the story AI each turn.
   *   - undefined / "all": every AI-readable variable, as always.
   *   - "changed": only the ones whose value differs from their default —
   *     a quieter block on cards with many settings-like variables.
   *   - "none": no <game-state> block at all; variables are the interface's
   *     business (the AI can still be told about them in its entries).
   */
  variablesToAi?: "all" | "changed" | "none";
  /** @deprecated Use uiMode instead */
  layoutMode?: "split" | "game-focus" | "immersive";
  /** @deprecated No longer used — layout is automatic based on world content */
  uiMode?: "chat" | "per-reply" | "persistent";
  /** When true, request JSON structured output from the LLM via response_format */
  structuredOutput?: boolean;
}

/** A content-only override of one author-approved world entry. */
export interface LiveCanonBasePatch {
  baseEntryId: string;
  content: string;
}

/** A lower-trust lore entry created for one play session. */
export interface LiveCanonCreatedEntry {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  alwaysSend: boolean;
  keywords: string[];
  matchWholeWords?: boolean;
}

export interface LiveCanonOverlay {
  basePatches: LiveCanonBasePatch[];
  createdEntries: LiveCanonCreatedEntry[];
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
