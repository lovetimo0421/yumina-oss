// First-party extensions: the catalog of WHICH extensions exist (and what they
// do) lives here in code, because extensions are real first-party features with
// server behavior. The DB only tracks per-user install state, reviews, and
// denormalized stats — all keyed by the stable string `key` below. This keeps a
// clean path to third-party extensions later (swap the static registry for a
// loader that unions static + DB rows; every FK already keys on the string).

export type ExtensionCategory = "memory" | "narrative" | "tools" | "social";

// ─── Extension API contract ─────────────────────────────────────────
// The host's extension contract version. Bump when the registry/hook/slot
// contract changes incompatibly; extensions declare the version they target
// and the host refuses incompatible entries instead of mis-running them.

export const CURRENT_EXTENSION_API_VERSION = 1;
export const MIN_SUPPORTED_EXTENSION_API_VERSION = 1;

export function isExtensionApiCompatible(def: Pick<ExtensionDefinition, "apiVersion">): boolean {
  return (
    def.apiVersion >= MIN_SUPPORTED_EXTENSION_API_VERSION && def.apiVersion <= CURRENT_EXTENSION_API_VERSION
  );
}

/**
 * UI slots an extension can fill inside the sandbox chat UI. All slots compose
 * by `priority` (lower renders first) — except `chat.renderer`, which is
 * EXCLUSIVE and resolves by explicit policy (world rootComponent > default);
 * extensions cannot claim it today.
 */
export type ContributionPoint =
  | "chat.composer.toolbar"
  | "chat.message.actions"
  | "chat.settings.panel"
  | "chat.renderer";

export interface ContributionDecl {
  point: ContributionPoint;
  /** Composition order within the slot; lower first, ties break by extension key. */
  priority?: number;
}

/**
 * Server lifecycle seams in the message pipeline. Hooks RETURN DATA and never
 * mutate the pipeline; the trusted dispatcher composes results by priority.
 * `invalidate` is a data-lifecycle seam and runs even when uninstalled.
 */
export type ServerHookSeam =
  | "resolveCapabilities"
  | "contributePromptBlocks"
  | "filterHistory"
  | "onPromptOverflow"
  | "onTurnComplete"
  | "validateTurnOutput"
  | "invalidate";

export interface ServerHookDecl {
  /** One of the extension's capabilityHookIds. */
  capability: string;
  seam: ServerHookSeam;
  /** Composition order at the seam; lower first, default 0. */
  priority?: number;
}

export interface ExtensionDefinition {
  /** Stable, immutable key — the FK used everywhere (DB, gates, reviews). */
  key: string;
  name: string;
  /** Card subtitle / one-liner. */
  shortDescription: string;
  /** Detail-page body (markdown). */
  longDescription: string;
  /** lucide icon name or asset key rendered on the card/detail hero. */
  icon: string;
  category: ExtensionCategory;
  tags: string[];
  /** Display-only semver. */
  version: string;
  /** "Yumina" for first-party. */
  author: string;
  /** CDN keys / URLs for the detail gallery. */
  screenshots: string[];
  /**
   * "What it does" cards shown in the detail popup's Overview tab, alongside the
   * markdown description (mirrors the worlds "Author's Note" panels).
   */
  explanations: { title: string; body: string }[];
  /**
   * Capabilities this extension gates. Pipeline code asks "is the extension that
   * owns capability X installed?" via the registry rather than hardcoding the
   * key at every call site — so a future extension just registers its own hook.
   */
  capabilityHookIds: string[];
  /** true in v1 (everything is first-party); future third-party rows = false. */
  firstParty: boolean;
  /** Extension API contract version this entry targets (see CURRENT_EXTENSION_API_VERSION). */
  apiVersion: number;
  /** UI slots this extension fills; the actual components register at runtime. */
  contributions?: ContributionDecl[];
  /** Server pipeline seams this extension taps, keyed by capability. */
  serverHooks?: ServerHookDecl[];
  /**
   * Capabilities requested, declared up front (Chrome-style). Documentation-only
   * today — nothing enforces them; kept so manifests stay forward-compatible.
   */
  permissions?: string[];
  /**
   * Key into the sandbox's static client-module import map. Present iff the
   * extension ships sandbox UI; the module is lazy-import()ed only when the
   * extension is installed (uninstalled = chunk never fetched).
   */
  clientEntry?: string;
  /** Hidden entries are installable but never listed in the Discover hub. */
  hidden?: boolean;
}

/** The session-memory + story-summary subsystem, the first/test extension. */
export const SESSION_MEMORY_EXTENSION_KEY = "session-memory-summary";

export const EXTENSION_REGISTRY: readonly ExtensionDefinition[] = [
  {
    key: "state-update-guard",
    name: "State Update Guard (Beta)",
    shortDescription: "Checks the AI's state-update format before saving a reply. Missing or broken commands get one correction attempt.",
    longDescription: "Keep existing cards and their variables. Every protected reply must return valid state commands or explicitly acknowledge no AI updates. The guard checks the complete batch before applying it and asks your selected correction model for one correction only when needed. If checking fails, the previous story state stays saved and the turn is not charged.\n\nSaved corrections with paid Yumina models cost mushies. The default model is Gemini 2.5 Flash Lite, matching Session Memory. Choose Use free model in the guard panel for free corrections. BYOK corrections do not deduct mushies, but your own API provider may charge. Format checks are free. Correct format does not guarantee correct story facts. Uninstall disables protection for future turns; saved state and diagnostics are retained. Install changes may take up to 60 seconds to reach every server.",
    icon: "shield-check", category: "tools", tags: ["state", "reliability", "beta"],
    version: "1.0.0", author: "Yumina", screenshots: [], firstParty: true, apiVersion: 1,
    explanations: [
      { title: "Existing cards", body: "Uses existing commands and variables. No card prompt or UI rewrite." },
      { title: "Explicit outcome", body: "Distinguishes checked commands, no AI updates, and a failed check. Automatic game rules still run." },
      { title: "One correction", body: "No extra call on valid replies. One bounded correction with your selected model for invalid output. Saved paid Yumina corrections cost mushies; free models and BYOK do not deduct mushies. BYOK provider charges may apply." },
    ],
    capabilityHookIds: ["state-update-guard"], clientEntry: "state-update-guard",
    contributions: [{ point: "chat.composer.toolbar", priority: 40 }],
    serverHooks: [{ capability: "state-update-guard", seam: "validateTurnOutput" }],
    // Player-facing opt-in beta, listed like Session Memory. Only developer
    // proof extensions (such as turn-counter) should stay hidden.
  },
  {
    key: SESSION_MEMORY_EXTENSION_KEY,
    name: "Session Memory & Story Summary (Beta)",
    shortDescription:
      "Keeps your story memory small without losing the plot. Older scenes become a recap, key facts stay on a list. Beta.",
    // Kept deliberately short. The three cards below carry the detail; when
    // this repeated them the modal said the same thing twice in a row, then
    // a third time in the install toast.
    longDescription:
      "Story memory only keeps the most recent part of your conversation word for word. This extension makes sure the rest is not simply lost: older scenes are compressed into a \"story so far\" recap, and key facts (relationships, items, promises, goals) go onto a running list. Both are sent with every reply.\n\nThat is what lets a small story memory work. Keep it around 16,000 and let this carry everything older.\n\nWriting the notes costs a little, usually well under 1 mushie per update. One tap in the Memory panel switches it to the free model.\n\nBeta: it occasionally gets a detail wrong. Everything it writes can be read and edited in the Memory panel, above the chat box.",
    icon: "brain",
    category: "memory",
    tags: ["memory", "context", "long-play", "summary"],
    version: "1.0.0",
    author: "Yumina",
    screenshots: [],
    explanations: [
      {
        title: "Works with your story memory",
        body: "Set story memory to about 16,000 in AI settings. This carries everything older, so a small window stays cheap and sharp without losing the plot.",
      },
      {
        title: "You can read and change it",
        body: "Open the Memory panel above the chat box. Edit the notes, pin facts that must never drift, clear and regenerate, or switch the model it uses.",
      },
      {
        title: "Uninstalling keeps your notes",
        body: "Turning it off leaves everything written so far intact. Reinstall later and it picks the same notes back up.",
      },
    ],
    capabilityHookIds: ["session-memory", "story-summary", "summaryception"],
    firstParty: true,
    apiVersion: 1,
    clientEntry: "session-memory",
    contributions: [{ point: "chat.composer.toolbar", priority: 10 }],
    serverHooks: [
      // One resolver decides which of the three systems are active this turn.
      { capability: "session-memory", seam: "resolveCapabilities" },
      // Prompt-block composition order (matches the injection order right
      // before raw history): story summary → summaryception → session memory.
      { capability: "story-summary", seam: "contributePromptBlocks", priority: 10 },
      { capability: "summaryception", seam: "contributePromptBlocks", priority: 20 },
      { capability: "session-memory", seam: "contributePromptBlocks", priority: 30 },
      { capability: "story-summary", seam: "filterHistory" },
      { capability: "summaryception", seam: "filterHistory" },
      { capability: "story-summary", seam: "onPromptOverflow" },
      { capability: "summaryception", seam: "onPromptOverflow" },
      { capability: "session-memory", seam: "onTurnComplete" },
      { capability: "story-summary", seam: "onTurnComplete" },
      { capability: "session-memory", seam: "invalidate" },
      { capability: "story-summary", seam: "invalidate" },
      { capability: "summaryception", seam: "invalidate" },
    ],
  },
  {
    // Hidden drop-in proof extension + living template for extension #2.
    // Proves the Phase 0 acceptance criterion: adding an extension touches only
    // a manifest entry + a sandbox client module + (if needed) a server hooks
    // file — zero edits to the chat UI or the message pipeline. Install in dev
    // via POST /api/extensions/turn-counter/install (never listed in the hub).
    key: "turn-counter",
    name: "Turn Counter (Dev)",
    shortDescription: "Dev-only drop-in proof: shows the session's message count in the composer toolbar.",
    longDescription:
      "A deliberately tiny first-party extension used to validate the extension rails. It contributes one toolbar badge and nothing else.",
    icon: "list-ordered",
    category: "tools",
    tags: ["dev"],
    version: "1.0.0",
    author: "Yumina",
    screenshots: [],
    explanations: [],
    capabilityHookIds: [],
    firstParty: true,
    apiVersion: 1,
    clientEntry: "turn-counter",
    contributions: [{ point: "chat.composer.toolbar", priority: 50 }],
    hidden: true,
  },
];

/** Hub-visible entries (hidden ones stay installable but are never listed). */
export function getVisibleExtensions(): readonly ExtensionDefinition[] {
  return EXTENSION_REGISTRY.filter((e) => !e.hidden);
}

export const EXTENSION_KEYS: readonly string[] = EXTENSION_REGISTRY.map((e) => e.key);

export function getExtensionDefinition(key: string): ExtensionDefinition | undefined {
  return EXTENSION_REGISTRY.find((e) => e.key === key);
}

export function isKnownExtensionKey(key: string): boolean {
  return EXTENSION_REGISTRY.some((e) => e.key === key);
}

/** Resolve which extension key owns a given capability hook id (first match). */
export function getExtensionKeyForCapability(capabilityId: string): string | undefined {
  return EXTENSION_REGISTRY.find((e) => e.capabilityHookIds.includes(capabilityId))?.key;
}

// ─── Payload types (server ⇄ app) ───────────────────────────────────

export type ExtensionInstallStatus = "installed" | "uninstalled" | "not-installed";

export interface ExtensionStats {
  downloadCount: number;
  reviewCount: number;
  averageRating: number;
}

export interface ExtensionInstallState {
  status: ExtensionInstallStatus;
  installedAt: string | null;
  uninstalledAt: string | null;
}

/** Hub/list card: definition subset + stats + (authed) viewer install state. */
export interface ExtensionSummary {
  key: string;
  name: string;
  shortDescription: string;
  icon: string;
  category: ExtensionCategory;
  tags: string[];
  author: string;
  version: string;
  stats: ExtensionStats;
  /** Present only for authenticated requests. */
  installState?: ExtensionInstallState;
}

/** Detail popup: full definition + stats + viewer install state. */
export interface ExtensionDetail extends ExtensionSummary {
  longDescription: string;
  screenshots: string[];
  explanations: { title: string; body: string }[];
  capabilityHookIds: string[];
  firstParty: boolean;
}

export interface ExtensionReviewPayload {
  /** 1-5. Optional: a comment can be posted without touching your rating. */
  rating?: number | null;
  content?: string | null;
}

/** One comment row, mirroring the worlds review shape. */
export interface ExtensionReviewWithUser {
  id: string;
  userId: string;
  extensionKey: string;
  /** Star snapshot taken when the comment was posted; null if none was given. */
  rating: number | null;
  content: string | null;
  hiddenByCreator: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  userName: string | null;
  userUsername: string | null;
  userImage: string | null;
}

export interface ExtensionRatingPayload {
  averageRating: number;
  /** Number of raters — NOT the number of comments in the feed. */
  reviewCount: number;
  /** Number of visible comments. Label the Reviews tab with this. */
  commentCount: number;
  /** Star histogram, keys "1".."5". */
  distribution?: Record<string, number>;
  /** The viewer's own rating; null when signed out or not yet rated. */
  myRating?: number | null;
}
