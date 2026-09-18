import { invalidJsonDefault } from "@/features/editor/lib/json-default";
import { create } from "zustand";
import { toPillText } from "@/lib/feedback-policy";
import { feedback } from "@/lib/feedback";
import type {
  WorldDefinition,
  Variable,
  Rule,
  Reaction,
  GameComponent,
  AudioTrack,
  WorldEntry,
  EntryFolder,
  InstalledBundle,
  YuminaBundle,
  LoreUiBinding,
  Worldbook,
} from "@yumina/engine";
import { nextBundleColorKey } from "@/lib/entry-constants";
import { materializeBehaviors } from "@/features/editor/lib/editable-behaviors";
import { migrateWorldDefinition, deriveSectionDefaults, deriveSectionDefaultsForEntry, OFFICIAL_PRESETS, customUIToRootFiles, normalizeFolders, mergeWorldDefinition, remapReactionReferences } from "@yumina/engine";
import type { OfficialPreset } from "@yumina/engine";
import type { WorldPendingEditSummary } from "@yumina/shared";
import type { WorldTemplate } from "@/lib/world-templates";
import i18n, { contentLanguage } from "@/lib/i18n";
import { uploadAssetWithPresignedUrl } from "@/lib/asset-upload";
import { useWorldsStore } from "./worlds";
import { hashRootFiles, COMPILED_FORMAT_VERSION } from "@/features/studio/lib/compiled-format";
import { serializeWorldSavePayload, worldSaveErrorMessage, worldSaveValidationMessage, worldSaveExceptionMessage, type WorldSaveErrorOptions } from "@/lib/world-save-payload";

const apiBase = import.meta.env.VITE_API_URL || "";

const saveErrorOptions: WorldSaveErrorOptions = {
  t: (key, options) => (i18n.t as (key: string, options: Record<string, unknown>) => string)(key, options),
};
/** origin/main's specific save reasons (size limit, expired session, validation) ride the same
 *  Retry pill as a generic failure; toPillText keeps the first sentence so it stays one line. */
function showWorldSaveError(reason: string) {
  saveFailed(reason);
}

// Per-session cache of compiled rootComponent JS, keyed by file hash, so an
// autosave that doesn't change the TSX doesn't recompile (Phase 3).
const rootCompileCache = new Map<string, string>();

const DRAFT_KEY = "yumina-editor-draft";

/**
 * Normalize entry positions to be sequential (0, 1, 2, ...) within each section.
 * Preserves relative order (sorts by current position first).
 * Guarantees no gaps, no collisions, no stale values.
 */
function normalizeLoreUiBindings(raw: unknown): LoreUiBinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const binding = item as Partial<LoreUiBinding>;
      const slotId = typeof binding.slotId === "string" ? binding.slotId.trim() : "";
      if (!slotId) return null;
      return {
        slotId,
        entryId: typeof binding.entryId === "string" ? binding.entryId : "",
        conditions: Array.isArray(binding.conditions) ? binding.conditions : [],
        conditionLogic: binding.conditionLogic === "any" ? "any" : "all",
      } satisfies LoreUiBinding;
    })
    .filter((binding): binding is LoreUiBinding => binding !== null);
}

function normalizePositions(entries: WorldEntry[]): WorldEntry[] {
  const bySection = new Map<string, WorldEntry[]>();
  for (const entry of entries) {
    if (!bySection.has(entry.section)) bySection.set(entry.section, []);
    bySection.get(entry.section)!.push(entry);
  }
  const result: WorldEntry[] = [];
  for (const sectionEntries of bySection.values()) {
    sectionEntries.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (let i = 0; i < sectionEntries.length; i++) {
      result.push({ ...sectionEntries[i]!, position: i });
    }
  }
  return result;
}
/** Strips a trailing " (copy)" / " (copy 3)" so duplicating a duplicate gives
 *  "Name (copy 2)" instead of "Name (copy) (copy)". */
function stripCopySuffix(name: string, suffix: string): string {
  const open = name.lastIndexOf(" (");
  if (open === -1 || !name.endsWith(")")) return name;
  const inner = name.slice(open + 2, -1).trim();
  const isBare = inner === suffix;
  const isNumbered =
    inner.startsWith(suffix) && /^\d+$/.test(inner.slice(suffix.length).trim());
  return isBare || isNumbered ? name.slice(0, open) : name;
}

/** First unused "<base> (copy)" / "<base> (copy N)" name. */
function nextCopyName(sourceName: string, entries: WorldEntry[], suffix: string): string {
  const base = stripCopySuffix(sourceName, suffix);
  const taken = new Set(entries.map((e) => e.name));
  for (let n = 1; n <= entries.length + 1; n++) {
    const candidate = n === 1 ? `${base} (${suffix})` : `${base} (${suffix} ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${suffix})`;
}

const AUTOSAVE_DELAY = 2000;
const SERVER_AUTOSAVE_INTERVAL = 60_000; // Auto-save to server every 60s when dirty
const MAX_HISTORY = 20;

function defaultComponentConfigByType(type: GameComponent["type"]): GameComponent["config"] {
  switch (type) {
    case "stat-bar":
      return { variableId: "" };
    case "text-display":
      return { variableId: "" };
    case "image-panel":
      return { variableId: "" };
    case "inventory-grid":
      return { variableId: "" };
    case "web-panel":
      return {};
  }
}

function presetToEntry(preset: OfficialPreset): WorldEntry {
  const defaults = deriveSectionDefaults(preset.section);
  return {
    id: crypto.randomUUID(),
    name: preset.name,
    content: preset.content,
    role: "system",
    apiRole: preset.apiRole,
    alwaysSend: defaults.alwaysSend,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    position: preset.position,
    section: preset.section,
    presetId: preset.presetId,
    tags: ["Preset"],
  };
}

const DEFAULT_ROOT_ENTRY_TSX = `export default function MyWorld() {\n  return <Chat />;\n}`;

function createDefaultRootComponent(): WorldDefinition["rootComponent"] {
  return {
    id: crypto.randomUUID(),
    name: "World Component",
    entryFile: "index.tsx",
    files: {
      "index.tsx": DEFAULT_ROOT_ENTRY_TSX,
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Bundle composition contract:
 *    - entryFile is ALWAYS "index.tsx" (runtime + studio invariant).
 *    - When any bundle has been imported, index.tsx is an auto-generated
 *      composer that mounts __user-root.tsx + each _bundles/{slug}/index.tsx.
 *    - The user's own main UI lives in __user-root.tsx and is the file they
 *      edit in Studio. index.tsx is regenerated on every bundle import and
 *      marked with COMPOSED_MARKER so we can detect it across imports.
 *    - The composer wraps UserRoot in an absolute-positioned flex box so the
 *      user's `<Chat />` lays out predictably regardless of host styling, then
 *      renders each bundle as a trailing sibling (bundles use position:fixed
 *      overlays so they don't affect UserRoot's flow). */
export const USER_ROOT_PATH = "__user-root.tsx";
export const COMPOSED_MARKER = "// AUTO-GENERATED by importBundle";
/** Regex for bundle namespace folders produced by importBundle. */
export const BUNDLE_NS_RE = /^_bundles\/([^/]+)\/index\.tsx$/;

export function generateComposedIndex(bundleFolders: string[]): string {
  const imports = [
    `import UserRoot from "./__user-root";`,
    ...bundleFolders.map((f, i) => `import Bundle${i} from "./_bundles/${f}/index";`),
  ];
  const bundleMounts = bundleFolders
    .map((_, i) => `      <Bundle${i} />`)
    .join("\n");
  return (
    `${COMPOSED_MARKER} — do not edit. Regenerated on every bundle import.\n` +
    `// Edit ./__user-root.tsx to change your main UI.\n` +
    imports.join("\n") +
    `\n\nexport default function App() {\n` +
    `  return (\n` +
    `    <>\n` +
    `      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>\n` +
    `        <UserRoot />\n` +
    `      </div>\n` +
    bundleMounts +
    (bundleMounts ? "\n" : "") +
    `    </>\n` +
    `  );\n` +
    `}\n`
  );
}

// ── Bundle change detection ────────────────────────────────────────
// To warn before deleting a bundle the user has since edited, we hash a
// normalized projection of the bundle's content at import time and compare it
// against the same projection of the world's *current* content on delete.
// Volatile fields (ids, positions, priorities) are excluded so reordering or
// id-remapping isn't mistaken for an edit; collections are sorted by id so
// ordering doesn't matter.

/** Deterministic JSON with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** djb2 string hash → short base36 string. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Content-only projection of a bundle's items (ids/positions/priorities dropped). */
function projectBundleContent(input: {
  entries: WorldEntry[];
  variables: Variable[];
  rules: Rule[];
  reactions?: Reaction[];
  audioTracks: AudioTrack[];
  files: Record<string, string>;
}): string {
  // Mirror normalizeEntryRoles (runs on every load) so an unedited bundle
  // hashes the same before and after a save/reload cycle.
  const normRole = (r: WorldEntry["role"]) =>
    r === "personality" ? "character" : r === "lore" ? "system" : r;
  const entries = [...input.entries].sort(byId).map((e) => ({
    name: e.name, content: e.content, role: normRole(e.role), apiRole: e.apiRole ?? null,
    section: e.section, depth: e.depth ?? null,
    enabled: typeof e.enabled === "boolean" ? e.enabled : true,
    keywords: Array.isArray(e.keywords) ? e.keywords : [],
    secondaryKeywords: e.secondaryKeywords ?? [],
    conditions: e.conditions ?? [], tags: e.tags ?? [],
  }));
  const variables = [...input.variables].sort(byId).map((v) => ({
    name: v.name, type: v.type, defaultValue: v.defaultValue,
    min: v.min ?? null, max: v.max ?? null,
    behaviorRules: v.behaviorRules ?? v.updateHints ?? "",
  }));
  const rules = [...input.rules].sort(byId).map((r) => ({
    name: r.name, trigger: r.trigger, conditions: r.conditions,
    conditionLogic: r.conditionLogic, actions: r.actions,
  }));
  const audioTracks = [...input.audioTracks].sort(byId).map((t) => ({
    name: t.name, type: t.type, url: t.url,
  }));
  const files = Object.keys(input.files).sort().map((k) => [k, input.files[k]]);
  // `reactions` joins the projection only when the bundle actually has some.
  // originalHash is persisted per install; adding an unconditional key would
  // change every stored hash and flag every already-installed bundle as
  // user-modified.
  const reactions = [...(input.reactions ?? [])].sort(byId).map((r) => ({
    name: r.name, when: r.when, conditions: r.conditions,
    conditionLogic: r.conditionLogic, then: r.then,
  }));
  return stableStringify({
    entries, variables, rules,
    ...(reactions.length > 0 ? { reactions } : {}),
    audioTracks, files,
  });
}

/** Extract a bundle's `_bundles/{slug}/` files keyed by their path *within* the
 *  folder, so the hash is stable regardless of the slug (which can be suffixed). */
function bundleFilesFor(slug: string | undefined, allFiles: Record<string, string>): Record<string, string> {
  if (!slug) return {};
  const prefix = `_bundles/${slug}/`;
  const out: Record<string, string> = {};
  for (const [path, code] of Object.entries(allFiles)) {
    if (path.startsWith(prefix)) out[path.slice(prefix.length)] = code;
  }
  return out;
}

function createEmptyWorld(): WorldDefinition {
  return {
    id: crypto.randomUUID(),
    version: "21.0.0",
    name: "",
    description: "",
    author: "",
    coverCrop: { x: 0, y: 0, zoom: 1, fit: "cover" },
    galleryCoverCrop: { x: 0, y: 0, zoom: 1, fit: "cover" },
    entries: OFFICIAL_PRESETS.map(presetToEntry),
    variables: [],
    rules: [],
    components: [],
    uiBlueprint: undefined,
    audioTracks: [],
    customUI: [],
    customTags: [],
    entryFolders: [],
    loreUiBindings: [],
    worldbooks: [],
    rootComponent: createDefaultRootComponent(),
    settings: {
      maxTokens: 12000,
      maxContext: 200000,
      temperature: 1.0,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      playerName: "User",
      lorebookScanDepth: 2,
      lorebookRecursionDepth: 0,
    },
  };
}


export type EditorSection =
  | "generation"
  | "first-message"
  | "entries"
  | "variables"
  | "rules"
  | "components"
  | "audio"
  | "assets"
  | "overview"
  | "bundles";

interface EditorState {
  worldDraft: WorldDefinition;
  serverWorldId: string | null;
  isDirty: boolean;
  activeSection: EditorSection;
  saving: boolean;
  loadingWorld: boolean;

  /** When true, a server refresh was deferred because the editor had unsaved changes. Consumed after next saveDraft(). */
  _pendingServerRefresh: boolean;

  /**
   * The server `updatedAt` the editor last synced with (load / refresh / save).
   * Sent on saveDraft as an optimistic-concurrency token so the server can
   * reject a stale whole-blob save that would clobber the Studio agent's
   * field-level writes (draft worlds — entry-folder data-loss bug). Null until
   * first synced; null disables the guard for that save.
   */
  baseUpdatedAt: string | null;

  /**
   * The last synced schema or successfully saved client snapshot. Used
   * as the common ancestor for the STALE_WORLD 3-way merge so the editor's edits
   * and the agent's edits combine instead of one clobbering the other. Null when
   * there is no clean server ancestor (createNew / crash-recovery).
   */
  _baseSchema: WorldDefinition | null;

  // DB-level fields (not part of WorldDefinition schema)
  galleryImages: string[];
  announcement: string;
  approxTime: string;
  tags: string[];
  worldIsPublished: boolean;
  /**
   * Authoritative lifecycle status of the loaded world (draft / pending_review /
   * rejected / published / unpublished), taken from the world-detail response.
   * The review-state chip needs this as a fallback: it used to resolve status
   * ONLY from the worlds-list store, which is empty on a direct editor load and
   * omits non-representative language variants — so an in-review card rendered
   * as "Not live" while saves were correctly 409-blocked with WORLD_IN_REVIEW.
   */
  worldStatus: string | null;
  /**
   * When the world was last submitted for review (ISO string, null when never /
   * withdrawn). Compared against baseUpdatedAt by the review-state chip to show
   * "in review, but you saved newer changes" as a distinct state.
   */
  submittedForReviewAt: string | null;
  /** Re-fetch just the lifecycle status/isPublished from the server (lean, primary read). */
  refreshWorldStatus: () => Promise<void>;
  // Edit re-review: held material change on an already-published world. Null
  // when the world has no held edit. See WorldPendingEditSummary.
  pendingEdit: WorldPendingEditSummary | null;
  language: string | null;
  languageGroupId: string | null;
  variantLabel: string | null;

  // Variant tab bar state
  variants: Array<{ id: string; name: string; variantLabel: string | null; language: string | null; thumbnailUrl: string | null; isPrimaryVariant: boolean; status?: string | null }>;
  variantsLoading: boolean;

  // Admin read-only inspection: when true, save/publish UI is suppressed and
  // autosave is disabled. The editor still loads the world and renders all
  // sections so an admin can audit content without changing it.
  readOnlyInspect: boolean;
  setReadOnlyInspect: (value: boolean) => void;
  guestMode: boolean;
  setGuestMode: (value: boolean) => void;

  /** Custom UI section sub-tab (code vs lore bindings). */
  customUiTab: "code" | "bindings";
  setCustomUiTab: (tab: "code" | "bindings") => void;

  // History
  _past: WorldDefinition[];
  _future: WorldDefinition[];
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Monotonic counter bumped on every undo()/redo(). Debounced editor fields
   * watch this to force-resync their local text even while focused — a plain
   * worldDraft change is ignored by a focused field (so typing isn't yanked),
   * but an explicit undo/redo MUST override that guard or the rollback stays
   * invisible in the field the user is editing.
   */
  _undoEpoch: number;
  undo: () => void;
  redo: () => void;

  // Actions
  createNew: () => void;
  loadWorld: (worldId: string) => Promise<void>;
  /**
   * Pull current server truth into the editor. Studio calls this after an agent
   * run so the agent's changes appear. When the editor has unsaved edits it
   * 3-way merges (server + local) instead of bailing — that bail was the bug
   * where the agent's changes didn't show until a reload. (`force` is vestigial.)
   */
  refreshWorldSchema: (force?: boolean) => Promise<void>;
  /** Submit a held material edit (published world) to the moderation queue. */
  submitPendingEdit: () => Promise<boolean>;
  /** Pull a submitted held edit back out of the queue so it can be edited. */
  withdrawPendingEdit: () => Promise<boolean>;
  loadWorldFromData: (data: { id: string; name: string; description: string | null; schema: Record<string, unknown>; thumbnailUrl: string | null }) => void;
  setActiveSection: (section: EditorSection) => void;
  setField: <K extends keyof WorldDefinition>(
    key: K,
    value: WorldDefinition[K]
  ) => void;
  setSettings: (
    key: keyof WorldDefinition["settings"],
    value: string | number | boolean
  ) => void;

  // Entry actions (replaces character + lorebook)
  addEntry: (role?: WorldEntry["role"], section?: NonNullable<WorldEntry["section"]>, placement?: Partial<Pick<WorldEntry, "folderId" | "worldbookId" | "content">>) => void;
  updateEntry: (id: string, updates: Partial<WorldEntry>) => void;
  /** Clones an entry directly below its source. Returns the new id (null if the
   *  source is gone) so callers can select it. `copySuffix` is the localized
   *  word used in the copy's name — passed in because the store has no t(). */
  duplicateEntry: (id: string, copySuffix?: string) => string | null;
  removeEntry: (id: string) => void;
  /** Renumber positions for EXACTLY the passed ids (per-section dense, in the
   *  given order); entries not listed keep their current position. */
  reorderEntries: (entryIds: string[]) => void;

  // Worldbook actions (lore modules)
  addWorldbook: (name?: string) => void;
  updateWorldbook: (id: string, patch: Partial<Worldbook>) => void;
  removeWorldbook: (id: string) => void;
  setEntryWorldbook: (entryId: string, worldbookId: string | undefined) => void;

  // Folder actions
  addFolder: (section: NonNullable<WorldEntry["section"]>, name?: string, worldbookId?: string) => void;
  removeFolder: (folderId: string) => void;
  renameFolder: (folderId: string, name: string) => void;
  moveFolder: (folderId: string, newSection: NonNullable<WorldEntry["section"]>) => void;

  // Tag management
  addCustomTag: (tagName: string) => void;
  removeCustomTag: (tagName: string) => void;
  renameCustomTag: (oldName: string, newName: string) => void;
  setCustomTagColor: (tagName: string, color: string | null) => void;
  // Variable actions
  addVariable: () => void;
  /** Update the variable at `index`. Addressed by position, not by id — ids
   *  are user-editable and were historically duplicable, and id-addressed
   *  updates hit every row sharing the id (2026-07-10 community report).
   *  When `updates.id` is set it is deduped against the other variables
   *  (auto-suffix _2/_3) and an empty id keeps the current one. */
  updateVariableAt: (index: number, updates: Partial<Variable>) => void;
  /** Remove the variable at `index` (positional — see updateVariableAt). */
  removeVariableAt: (index: number) => void;
  /** Find a variable by name (trimmed), or create one and return its id. Used by
   *  behaviors that write into a creator-named variable so they don't have to
   *  pre-create it in the Variables tab. Pass `internal` for engine-managed
   *  bookkeeping vars (e.g. random-pick cooldown history) — hidden from the list
   *  and never shown to the AI. */
  ensureVariableByName: (name: string, type: Variable["type"], defaultValue: Variable["defaultValue"], internal?: boolean) => string;
  // Component actions
  addComponent: (type?: GameComponent["type"]) => void;
  updateComponent: (id: string, updates: Partial<GameComponent>) => void;
  removeComponent: (id: string) => void;
  reorderComponents: (componentIds: string[]) => void;

  // Audio track actions
  addAudioTrack: () => void;
  updateAudioTrack: (id: string, updates: Partial<AudioTrack>) => void;
  removeAudioTrack: (id: string) => void;
  setBgmPlaylist: (playlist: import("@yumina/engine").BGMPlaylist | undefined) => void;
  updateBgmPlaylist: (updates: Partial<import("@yumina/engine").BGMPlaylist>) => void;
  addConditionalBGM: () => void;
  updateConditionalBGM: (id: string, updates: Record<string, unknown>) => void;
  removeConditionalBGM: (id: string) => void;

  // Root component actions — the only visual-layer API. Every world has
  // exactly one rootComponent (v19→v20 migration guarantees this); editor UI
  // manipulates its `files` map and entry file. The old v1 customUI[] mutators
  // (addCustomUI / updateCustomUI / removeCustomUI) + their legacy wrappers
  // (addCustomComponent / setMessageRenderer / etc.) were removed in phase 6
  // once all editor UI was migrated to rootComponent.
  updateRootComponent: (updates: { name?: string; entryFile?: string; files?: Record<string, string> }) => void;

  // Rule actions
  addRule: (variableId?: string) => void;
  updateRule: (id: string, updates: Partial<Rule>) => void;
  removeRule: (id: string) => void;
  reorderRules: (ruleIds: string[]) => void;

  // Reaction actions (event-driven rules)
  addReaction: () => void;
  updateReaction: (id: string, updates: Partial<Reaction>) => void;
  removeReaction: (id: string) => void;

  // Templates & import
  loadTemplate: (template: WorldTemplate) => void;
  /**
   * Replace the editor's current world draft with `def`.
   *
   * When `options.preserveServerState` is true, server-side metadata
   * (serverWorldId, publish status, gallery, tags, announcement, approxTime,
   * language group / variant info) is kept so a subsequent save PATCHes the
   * existing world rather than creating a new one. Use this when importing
   * JSON from inside the editor of an already-saved world — clearing
   * `serverWorldId` there would leave the route page stuck on its loading
   * spinner because `serverWorldId !== worldId` becomes permanently true.
   */
  loadWorldDefinition: (
    def: WorldDefinition,
    options?: { preserveServerState?: boolean }
  ) => void;
  /**
   * Upload `blob` as the current world's cover. Used after importing a PNG
   * character card (the PNG visual is the card's cover). Saves the world
   * first if it has no server id yet, since the thumbnail endpoint needs an
   * owned world. Updates `avatar` for immediate display.
   */
  applyImportedCover: (blob: Blob) => Promise<void>;
  importBundle: (bundle: YuminaBundle, sourceBundleId?: string) => void;
  /** Remove a previously-imported bundle and all the content it added. */
  removeInstalledBundle: (installId: string) => void;
  /** True if the user has edited any of the bundle's content since import. */
  isInstalledBundleModified: (installId: string) => boolean;

  // Undo batching — wrap multiple mutations in a single undo entry
  _batchDepth: number;
  _batchStartDraft: WorldDefinition | null;
  beginBatch: () => void;
  commitBatch: () => void;

  // DB-level field setters
  setGalleryImages: (images: string[]) => void;
  setAnnouncement: (value: string) => void;
  setApproxTime: (value: string) => void;
  setTags: (tags: string[]) => void;
  setLanguage: (value: string | null) => void;
  setVariantLabel: (value: string | null) => void;

  // Variant actions
  loadVariants: () => Promise<void>;
  createVariant: (label: string, language?: string | null) => Promise<string | null>;
  // Promote a variant to 主 (primary) for its language; demotes same-language siblings.
  setPrimary: (variantId: string) => Promise<void>;

  // Save — resolves true on success, false on failure
  saveDraft: () => Promise<boolean>;
  /** Timestamp of the last successful save. Drives the header's transient
   *  "Saved" label (there is no save toast) — bumped on every save, manual
   *  or autosave, so a repeat save re-triggers it. */
  lastSavedAt: number;
  loadDraftFromStorage: () => void;
  clearDraft: () => void;
  /** Stop the autosave timer without resetting editor state. Call on route unmount. */
  stopAutosave: () => void;
}

/** i18n from a store: no hook here, so read through the instance. */
const tr = (key: string, fallback: string, opts?: Record<string, unknown>) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, {
    defaultValue: fallback,
    ...opts,
  });

// R7 pills. These failures happen with nothing on screen to anchor to — an
// empty editor for a failed load, a header that just stopped spinning for a
// failed save — so each offers the same call again as Retry.
function loadWorldFailed(worldId: string) {
  feedback.error(tr("editor:shell.loadWorldFailed", "Couldn't load this world"), {
    label: tr("common:action.retry", "Retry"),
    onClick: () => void useEditorStore.getState().loadWorld(worldId),
  });
}

// A later successful save retires the failure pill (origin/main dismissed its toast by id).
let dismissSaveError: (() => void) | null = null;
function saveFailed(reason?: string) {
  dismissSaveError?.();
  dismissSaveError = feedback.error(toPillText(reason ?? tr("editor:save.failed", "Couldn't save your changes")), {
    label: tr("common:action.retry", "Retry"),
    onClick: () => void useEditorStore.getState().saveDraft(),
  });
}

function setPrimaryFailed(variantId: string) {
  feedback.error(tr("editor:variantBar.setPrimaryFailed", "Couldn't set the primary version"), {
    label: tr("common:action.retry", "Retry"),
    onClick: () => void useEditorStore.getState().setPrimary(variantId),
  });
}

// The crash-recovery pill is persistent (Infinity duration) and the Toaster
// lives above the router, so it would otherwise survive a navigation and let a
// click overwrite a DIFFERENT world's draft with the recovered schema. Every
// path that swaps the loaded world retires it.
let dismissRecoveryPill: (() => void) | null = null;

function retireRecoveryOffer() {
  dismissRecoveryPill?.();
  dismissRecoveryPill = null;
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let serverAutosaveTimer: ReturnType<typeof setInterval> | null = null;
let loadAbort: AbortController | null = null;
// Distinguish editor visits, including A -> B -> A and two unsaved new cards.
// An old save must never update the draft loaded after its request started.
let editorSession = 0;
let activeSave: { session: number; promise: Promise<boolean> } | null = null;

function serializeEditorSave(save: () => Promise<boolean>): Promise<boolean> {
  const session = editorSession;
  if (activeSave?.session === session) {
    // Studio waits for saving before starting the agent. Joining callers must
    // wait too, and flush edits made during the first request before proceeding.
    return activeSave.promise.then((saved) => {
      if (session !== editorSession || !saved) return false;
      return useEditorStore.getState().isDirty ? useEditorStore.getState().saveDraft() : true;
    });
  }
  const promise = save().finally(() => {
    if (activeSave?.promise === promise) activeSave = null;
  });
  activeSave = { session, promise };
  return promise;
}

function canApplyServerSnapshot(
  updatedAt: unknown,
  started: Pick<EditorState, "baseUpdatedAt" | "_baseSchema">,
  current: Pick<EditorState, "baseUpdatedAt" | "_baseSchema">,
): boolean {
  const incomingTime = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  const currentTime = current.baseUpdatedAt ? Date.parse(current.baseUpdatedAt) : NaN;
  if (Number.isFinite(incomingTime) && Number.isFinite(currentTime)) {
    if (incomingTime !== currentTime) return incomingTime > currentTime;
  }
  // An equal or unknown version cannot supersede a snapshot accepted while
  // this request was in flight. With no intervening sync, keep legacy support
  // for responses that do not carry a concurrency token.
  return current.baseUpdatedAt === started.baseUpdatedAt && current._baseSchema === started._baseSchema;
}

function validServerToken(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Start the periodic server auto-save (every 60s if dirty). */
function startServerAutosave() {
  stopServerAutosave();
  serverAutosaveTimer = setInterval(() => {
    const state = useEditorStore.getState();
    if (state.isDirty && !state.saving && state.serverWorldId) {
      // No confirmation: saveDraft stamps lastSavedAt and the header derives
      // its own "Saved" state from it.
      void state.saveDraft();
    }
  }, SERVER_AUTOSAVE_INTERVAL);
}

function stopServerAutosave() {
  if (serverAutosaveTimer) { clearInterval(serverAutosaveTimer); serverAutosaveTimer = null; }
}

let newWorldSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDraftSave(draft: WorldDefinition, serverId: string | null) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    // Skip write if a server save already cleared the dirty flag
    if (!useEditorStore.getState().isDirty) return;
    // Serialize off the main thread to avoid blocking UI (large worlds can be 3-10MB)
    const schedule = typeof requestIdleCallback === "function" ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 200);
    schedule(() => {
      try {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ draft, serverId, savedAt: Date.now() })
        );
      } catch {
        // localStorage might be full
      }
    });
  }, AUTOSAVE_DELAY);

  // For new worlds (no serverWorldId): auto-save to server after 5s of edits
  // so Studio and Play become available without manual save
  if (!serverId) {
    if (newWorldSaveTimer) clearTimeout(newWorldSaveTimer);
    newWorldSaveTimer = setTimeout(() => {
      newWorldSaveTimer = null;
      const state = useEditorStore.getState();
      if (!state.serverWorldId && state.isDirty && !state.saving && state.worldDraft.name) {
        state.saveDraft().then((ok) => {
          if (ok) startServerAutosave();
        });
      }
    }, 5000);
  }
}

/** Pick a variable id that isn't already taken, by suffixing _2, _3, ...
 *  ("hp" → "hp_2"). Parentheses like "hp(1)" are not an option: the engine's
 *  {{id}} variable lookup only accepts /^\w+$/ (see engine prompts/macros.ts),
 *  so a parenthesized id would silently become a dead macro. */
export function dedupeVariableId(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  for (let n = 2; ; n++) {
    const candidate = `${desired}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Variable ids are the variable's identity: {{id}} macros, rules, components
 *  and the runtime state Record all key on them, and the runtime Record makes
 *  duplicates silently collapse into one slot. Duplicates also made editor
 *  edits/deletes hit both rows (2026-07-10 community report). Enforce
 *  uniqueness by renaming later duplicates with a _2/_3 suffix — safe because
 *  a duplicate's "references" never had working semantics to begin with.
 *  Returns the input array unchanged (same reference) when already unique. */
export function normalizeVariableIds(variables: Variable[]): Variable[] {
  const seen = new Set<string>();
  let changed = false;
  const out = variables.map((v) => {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      return v;
    }
    const next = dedupeVariableId(v.id, seen);
    seen.add(next);
    changed = true;
    return { ...v, id: next };
  });
  return changed ? out : variables;
}

/** Apply normalizeVariableIds to a draft, preserving object identity when
 *  nothing changed. */
function withNormalizedVariableIds(draft: WorldDefinition): WorldDefinition {
  const variables = normalizeVariableIds(draft.variables);
  return variables === draft.variables ? draft : { ...draft, variables };
}

/**
 * Push current worldDraft onto the _past stack, apply newDraft, clear _future.
 * Returns the partial state update for set().
 *
 * During a batch (_batchDepth > 0), only applies the draft without pushing to
 * _past — the batch start snapshot is pushed once on commitBatch().
 */
function commitDraft(
  s: EditorState,
  newDraft: WorldDefinition
): Partial<EditorState> {
  // Every worldDraft mutation funnels through here — heal duplicate variable
  // ids no matter which path introduced them (manual edit, AI actions, import).
  newDraft = withNormalizedVariableIds(newDraft);
  // Guest previews are genuinely read-only. Previously we applied the change
  // locally and only suppressed persistence, which let guests spend hours on a
  // draft that disappeared as soon as Save opened the sign-in flow.
  if (s.guestMode) {
    return {};
  }
  // Admin inspect mode: skip both the localStorage recovery scheduler and
  // the 60s server autosave. Admin can mutate the local store to explore
  // ("what does this look like with this entry expanded?"), but nothing
  // should escape the tab.
  if (s.readOnlyInspect) {
    if (s._batchDepth > 0) {
      return { worldDraft: newDraft };
    }
    return { worldDraft: newDraft, isDirty: true };
  }
  scheduleDraftSave(newDraft, s.serverWorldId);
  // First edit on a saved world → kick off the periodic server autosave.
  // For new worlds (no serverWorldId yet), scheduleDraftSave handles the
  // initial save itself and starts the timer on success.
  if (!s.isDirty && s.serverWorldId) {
    startServerAutosave();
  }
  if (s._batchDepth > 0) {
    // During batch: apply draft but don't push to undo stack
    return { worldDraft: newDraft, isDirty: true };
  }
  const past = [...s._past, s.worldDraft].slice(-MAX_HISTORY);
  return {
    worldDraft: newDraft,
    isDirty: true,
    _past: past,
    _future: [],
    canUndo: true,
    canRedo: false,
  };
}

function guestProtectedUpdate(
  s: Pick<EditorState, "guestMode">,
  update: Partial<EditorState>,
): Partial<EditorState> {
  return s.guestMode ? {} : update;
}

/**
 * Build the editor's WorldDefinition draft from a server world payload.
 *
 * Single source of truth for the load transform used by the STALE_WORLD 3-way
 * merge, so the server side it fetches is shaped identically to the worldDraft /
 * _baseSchema the editor already holds (the merge's common-ancestor invariant).
 * Kept in sync with the inline transform in loadWorld + refreshWorldSchema, which
 * predate this helper.
 */
function buildServerDraftFromData(data: any): WorldDefinition {
  const schema = (data.schema ?? {}) as WorldDefinition;
  const rawSchema = data.schema as Record<string, unknown> | undefined;
  const rawDraft: WorldDefinition = {
    id: schema.id || data.id,
    version: schema.version || "1.0.0",
    // DB name first — same rule as loadWorld (see comment there).
    name: data.name || schema.name || "",
    description: schema.description || data.description || "",
    author: schema.author || "",
    avatar: data.thumbnailUrl || schema.avatar,
    coverCrop: schema.coverCrop,
    galleryCoverCrop: schema.galleryCoverCrop,
    entries: schema.entries || [],
    variables: normalizeVariableIds(schema.variables || []),
    rules: schema.rules || [],
    reactions: schema.reactions || [],
    characters: schema.characters,
    components: schema.components || [],
    uiBlueprint: schema.uiBlueprint,
    audioTracks: schema.audioTracks || [],
    bgmPlaylist: schema.bgmPlaylist,
    conditionalBGM: schema.conditionalBGM,
    lorebookEntries: schema.lorebookEntries,
    customUI: schema.customUI || [],
    ...(rawSchema?.customComponents ? { customComponents: rawSchema.customComponents } : {}),
    ...(rawSchema?.messageRenderer ? { messageRenderer: rawSchema.messageRenderer } : {}),
    customTags: schema.customTags || [],
    entryFolders: schema.entryFolders,
    editorMode: schema.editorMode,
    rootComponent: schema.rootComponent,
    loreUiBindings: normalizeLoreUiBindings(schema.loreUiBindings),
    worldbooks: schema.worldbooks ?? [],
    settings: {
      maxTokens: schema.settings?.maxTokens ?? 12000,
      maxContext: schema.settings?.maxContext ?? 200000,
      temperature: schema.settings?.temperature ?? 1.0,
      topP: schema.settings?.topP ?? 1,
      frequencyPenalty: schema.settings?.frequencyPenalty ?? 0,
      presencePenalty: schema.settings?.presencePenalty ?? 0,
      topK: schema.settings?.topK,
      minP: schema.settings?.minP,
      playerName: schema.settings?.playerName ?? "User",
      systemPrompt: schema.settings?.systemPrompt,
      greeting: schema.settings?.greeting,
      lorebookScanDepth: schema.settings?.lorebookScanDepth ?? 2,
      lorebookRecursionDepth: schema.settings?.lorebookRecursionDepth ?? 0,
      layoutMode: schema.settings?.layoutMode,
      uiMode: schema.settings?.uiMode,
      ...((rawSchema?.settings as any)?.fullScreenComponent !== undefined
        ? { fullScreenComponent: (rawSchema!.settings as any).fullScreenComponent }
        : {}),
    },
  } as WorldDefinition;
  const draft = migrateWorldDefinition(rawDraft);
  draft.entries = normalizePositions(draft.entries);
  draft.entries = normalizeFolders(draft).world.entries;
  draft.loreUiBindings = normalizeLoreUiBindings(draft.loreUiBindings);
  return draft;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  worldDraft: createEmptyWorld(),
  serverWorldId: null,
  isDirty: false,
  activeSection: "entries",
  saving: false,
  loadingWorld: false,
  lastSavedAt: 0,
  _pendingServerRefresh: false,
  baseUpdatedAt: null,
  _baseSchema: null,

  // DB-level fields
  galleryImages: [],
  announcement: "",
  approxTime: "",
  tags: [],
  worldIsPublished: false,
  worldStatus: null,
  submittedForReviewAt: null,
  pendingEdit: null,
  language: null,
  languageGroupId: null,
  variantLabel: null,
  variants: [],
  variantsLoading: false,
  readOnlyInspect: false,
  setReadOnlyInspect: (value: boolean) => set({ readOnlyInspect: value }),
  guestMode: false,
  setGuestMode: (value: boolean) => set({ guestMode: value }),

  // History
  _past: [],
  _future: [],
  canUndo: false,
  canRedo: false,
  _undoEpoch: 0,

  // Undo batching
  _batchDepth: 0,
  _batchStartDraft: null,

  beginBatch: () => {
    set((s) => {
      if (s.guestMode) return {};
      if (s._batchDepth === 0) {
        return { _batchDepth: 1, _batchStartDraft: s.worldDraft };
      }
      return { _batchDepth: s._batchDepth + 1 };
    });
  },

  commitBatch: () => {
    set((s) => {
      if (s.guestMode) return {};
      const newDepth = s._batchDepth - 1;
      if (newDepth > 0) {
        return { _batchDepth: newDepth };
      }
      // Batch complete — push the start snapshot as a single undo entry
      if (s._batchStartDraft) {
        const past = [...s._past, s._batchStartDraft].slice(-MAX_HISTORY);
        return {
          _batchDepth: 0,
          _batchStartDraft: null,
          _past: past,
          _future: [],
          canUndo: true,
          canRedo: false,
        };
      }
      return { _batchDepth: 0, _batchStartDraft: null };
    });
  },

  undo: () => {
    set((s) => {
      if (s.guestMode) return {};
      if (s._past.length === 0) return s;
      const previous = s._past[s._past.length - 1]!;
      const newPast = s._past.slice(0, -1);
      const newFuture = [s.worldDraft, ...s._future];
      scheduleDraftSave(previous, s.serverWorldId);
      return {
        worldDraft: previous,
        _past: newPast,
        _future: newFuture,
        canUndo: newPast.length > 0,
        canRedo: true,
        isDirty: true,
        _undoEpoch: s._undoEpoch + 1,
      };
    });
  },

  redo: () => {
    set((s) => {
      if (s.guestMode) return {};
      if (s._future.length === 0) return s;
      const next = s._future[0]!;
      const newFuture = s._future.slice(1);
      const newPast = [...s._past, s.worldDraft];
      scheduleDraftSave(next, s.serverWorldId);
      return {
        worldDraft: next,
        _past: newPast,
        _future: newFuture,
        canUndo: true,
        canRedo: newFuture.length > 0,
        isDirty: true,
        _undoEpoch: s._undoEpoch + 1,
      };
    });
  },

  createNew: () => {
    editorSession++;
    retireRecoveryOffer();
    loadAbort?.abort();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    stopServerAutosave();
    const draft = createEmptyWorld();
    set({
      worldDraft: draft,
      serverWorldId: null,
      saving: false,
      loadingWorld: false,
      isDirty: false,
      activeSection: "entries",
      _past: [],
      _future: [],
      canUndo: false,
      canRedo: false,
      galleryImages: [],
      announcement: "",
      approxTime: "",
      tags: [],
      worldIsPublished: false,
      worldStatus: null,
      submittedForReviewAt: null,
      // Default to the creator's current UI language so the card surfaces in
      // their own Discover locale by default. The Overview language picker
      // still lets them switch to ja/ko/es/etc. before publish.
      language: contentLanguage(i18n.language),
      languageGroupId: null,
      variantLabel: null,      variants: [],
      variantsLoading: false,
      _pendingServerRefresh: false,
      baseUpdatedAt: null,
      _baseSchema: null,
    });
    localStorage.removeItem(DRAFT_KEY);
  },

  loadWorld: async (worldId: string) => {
    editorSession++;
    retireRecoveryOffer();
    loadAbort?.abort();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    const controller = new AbortController();
    loadAbort = controller;
    set({ loadingWorld: true, serverWorldId: null, saving: false });

    // Check for a crash-recovery draft BEFORE clearing localStorage
    let recoveryDraft: WorldDefinition | null = null;
    try {
      const savedRaw = localStorage.getItem(DRAFT_KEY);
      if (savedRaw) {
        const parsed = JSON.parse(savedRaw);
        if (
          parsed.serverId === worldId &&
          parsed.draft &&
          parsed.savedAt &&
          Date.now() - parsed.savedAt < 7 * 24 * 60 * 60 * 1000
        ) {
          recoveryDraft = migrateWorldDefinition(parsed.draft);
          recoveryDraft.entries = normalizePositions(recoveryDraft.entries);
        }
      }
    } catch { /* ignore corrupted storage */ }

    try {
      // forEdit=1: for the owner of a published world with a held edit, the
      // server overlays the pending working copy so we edit the in-progress
      // version (and returns the pendingEdit summary for the review banner).
      const res = await fetch(`${apiBase}/api/worlds/${worldId}?forEdit=1&_t=${Date.now()}`, {
        credentials: "include",
        signal: controller.signal,
        cache: "no-store",
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        loadWorldFailed(worldId);
        set({ loadingWorld: false });
        return;
      }
      const { data } = await res.json();
      if (controller.signal.aborted) return;
      const schema = (data.schema ?? {}) as WorldDefinition;
      const rawSchema = data.schema as Record<string, unknown> | undefined;

      // Build raw draft then migrate
      const rawDraft: WorldDefinition = {
        id: schema.id || data.id,
        version: schema.version || "1.0.0",
        // worlds.name (data.name) is the display-name truth — the hub, the
        // review queue and the publish NAME_REQUIRED gate all read it. The
        // schema copy can lag behind a publish-modal rename; preferring it
        // here would show the stale template name AND write it back over the
        // rename on the next save. schema.name is only a fallback.
        name: data.name || schema.name || "",
        description: schema.description || data.description || "",
        author: schema.author || "",
        avatar: data.thumbnailUrl || schema.avatar,
        coverCrop: schema.coverCrop,
        galleryCoverCrop: schema.galleryCoverCrop,
        entries: schema.entries || [],
        variables: normalizeVariableIds(schema.variables || []),
        rules: schema.rules || [],
        reactions: schema.reactions || [],
        characters: schema.characters,
        components: schema.components || [],
        uiBlueprint: schema.uiBlueprint,
        audioTracks: schema.audioTracks || [],
        bgmPlaylist: schema.bgmPlaylist,
        conditionalBGM: schema.conditionalBGM,
        lorebookEntries: schema.lorebookEntries,
        customUI: schema.customUI || [],
        // Pass deprecated v18 fields through for migrateV18ToV19
        ...(rawSchema?.customComponents ? { customComponents: rawSchema.customComponents } : {}),
        ...(rawSchema?.messageRenderer ? { messageRenderer: rawSchema.messageRenderer } : {}),
        customTags: schema.customTags || [],
        entryFolders: schema.entryFolders,
        editorMode: schema.editorMode,
        rootComponent: schema.rootComponent,
        loreUiBindings: normalizeLoreUiBindings(schema.loreUiBindings),
        worldbooks: schema.worldbooks ?? [],
        settings: {
          maxTokens: schema.settings?.maxTokens ?? 12000,
          maxContext: schema.settings?.maxContext ?? 200000,
          temperature: schema.settings?.temperature ?? 1.0,
          topP: schema.settings?.topP ?? 1,
          frequencyPenalty: schema.settings?.frequencyPenalty ?? 0,
          presencePenalty: schema.settings?.presencePenalty ?? 0,
          topK: schema.settings?.topK,
          minP: schema.settings?.minP,
          playerName: schema.settings?.playerName ?? "User",
          systemPrompt: schema.settings?.systemPrompt,
          greeting: schema.settings?.greeting,
          lorebookScanDepth: schema.settings?.lorebookScanDepth ?? 2,
          lorebookRecursionDepth: schema.settings?.lorebookRecursionDepth ?? 0,
          layoutMode: schema.settings?.layoutMode,
          uiMode: schema.settings?.uiMode,
          ...((rawSchema?.settings as any)?.fullScreenComponent !== undefined
            ? { fullScreenComponent: (rawSchema!.settings as any).fullScreenComponent }
            : {}),
        },
      } as WorldDefinition;

      const draft = migrateWorldDefinition(rawDraft);
      draft.entries = normalizePositions(draft.entries);
      // Heal dangling entry→folder refs so orphaned entries render (don't vanish).
      draft.entries = normalizeFolders(draft).world.entries;
      draft.loreUiBindings = normalizeLoreUiBindings(draft.loreUiBindings);
      if (controller.signal.aborted) return;

      set({
        worldDraft: draft,
        serverWorldId: data.id,
        isDirty: false,
        activeSection: "entries",
        loadingWorld: false,
        _past: [],
        _future: [],
        canUndo: false,
        canRedo: false,
        // DB-level fields
        galleryImages: Array.isArray(data.galleryImages) ? data.galleryImages : [],
        announcement: data.announcement ?? "",
        approxTime: data.approxTime ?? "",
        tags: Array.isArray(data.tags) ? data.tags : [],
        worldIsPublished: !!data.isPublished,
        worldStatus: (data.status as string | null) ?? (data.isPublished ? "published" : "draft"),
        submittedForReviewAt: typeof data.submittedForReviewAt === "string" ? data.submittedForReviewAt : null,
        pendingEdit: (data.pendingEdit ?? null) as WorldPendingEditSummary | null,
        language: data.language ?? null,
        languageGroupId: data.languageGroupId ?? null,
        variantLabel: data.variantLabel ?? null,
        variants: [],
        variantsLoading: false,
        _pendingServerRefresh: false,
        baseUpdatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
        _baseSchema: structuredClone(draft),
      });

      // Clear localStorage draft only after successful load
      localStorage.removeItem(DRAFT_KEY);

      // Offer crash recovery if we found a matching unsaved draft. It stays
      // until acted on (dropping it silently would lose the recovered work),
      // but it belongs to THIS world: the handle is retired by every world
      // swap, and the click re-checks the loaded id in case one slips through.
      if (recoveryDraft) {
        const recovered = recoveryDraft;
        dismissRecoveryPill = feedback.persistent(
          tr("editor:shell.recoverDraftFound", "Unsaved changes from last time"),
          {
            label: tr("editor:shell.recoverDraftAction", "Recover"),
            onClick: () => {
              dismissRecoveryPill = null;
              if (get().serverWorldId !== worldId) return;
              set(commitDraft(get(), recovered));
            },
          },
          { id: "editor-draft-recovery" },
        );
      }

      // Periodic auto-save is *not* started here. We wait until the user
      // makes their first edit — see commitDraft's isDirty transition —
      // so opening a world for read-only inspection never costs writes.

      // Auto-load variant tabs if this world belongs to a variant group
      if (data.languageGroupId) {
        get().loadVariants();
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("loadWorld error:", err);
      loadWorldFailed(worldId);
      set({ loadingWorld: false });
    }
  },

  refreshWorldSchema: async (_force = false) => {
    const started = get();
    const { serverWorldId } = started;
    const sessionAtRequest = editorSession;
    if (!serverWorldId) return;
    try {
      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}?forEdit=1&_t=${Date.now()}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const { data } = await res.json();
      if (sessionAtRequest !== editorSession || !data || data.id !== get().serverWorldId) return;
      if (!canApplyServerSnapshot(data.updatedAt, started, get())) return;
      const schema = (data.schema ?? {}) as WorldDefinition;
      const rawSchema = data.schema as Record<string, unknown> | undefined;
      const rawDraft: WorldDefinition = {
        id: schema.id || data.id,
        version: schema.version || "1.0.0",
        // DB name first — same rule as loadWorld (see comment there).
        name: data.name || schema.name || "",
        description: schema.description || data.description || "",
        author: schema.author || "",
        avatar: data.thumbnailUrl || schema.avatar,
        coverCrop: schema.coverCrop,
        galleryCoverCrop: schema.galleryCoverCrop,
        entries: schema.entries || [],
        variables: normalizeVariableIds(schema.variables || []),
        rules: schema.rules || [],
        reactions: schema.reactions || [],
        characters: schema.characters,
        components: schema.components || [],
        uiBlueprint: schema.uiBlueprint,
        audioTracks: schema.audioTracks || [],
        bgmPlaylist: schema.bgmPlaylist,
        conditionalBGM: schema.conditionalBGM,
        lorebookEntries: schema.lorebookEntries,
        customUI: schema.customUI || [],
        // Pass deprecated v18 fields through for migrateV18ToV19
        ...(rawSchema?.customComponents ? { customComponents: rawSchema.customComponents } : {}),
        ...(rawSchema?.messageRenderer ? { messageRenderer: rawSchema.messageRenderer } : {}),
        customTags: schema.customTags || [],
        entryFolders: schema.entryFolders,
        editorMode: schema.editorMode,
        rootComponent: schema.rootComponent,
        loreUiBindings: normalizeLoreUiBindings(schema.loreUiBindings),
        worldbooks: schema.worldbooks ?? [],
        settings: {
          maxTokens: schema.settings?.maxTokens ?? 12000,
          maxContext: schema.settings?.maxContext ?? 200000,
          temperature: schema.settings?.temperature ?? 1.0,
          topP: schema.settings?.topP ?? 1,
          frequencyPenalty: schema.settings?.frequencyPenalty ?? 0,
          presencePenalty: schema.settings?.presencePenalty ?? 0,
          topK: schema.settings?.topK,
          minP: schema.settings?.minP,
          playerName: schema.settings?.playerName ?? "User",
          systemPrompt: schema.settings?.systemPrompt,
          greeting: schema.settings?.greeting,
          lorebookScanDepth: schema.settings?.lorebookScanDepth ?? 2,
          lorebookRecursionDepth: schema.settings?.lorebookRecursionDepth ?? 0,
          layoutMode: schema.settings?.layoutMode,
          uiMode: schema.settings?.uiMode,
          ...((rawSchema?.settings as any)?.fullScreenComponent !== undefined
            ? { fullScreenComponent: (rawSchema!.settings as any).fullScreenComponent }
            : {}),
        },
      } as WorldDefinition;
      const draft = migrateWorldDefinition(rawDraft);
      draft.entries = normalizePositions(draft.entries);
      // Heal dangling entry→folder refs so orphaned entries render (don't vanish).
      draft.entries = normalizeFolders(draft).world.entries;
      draft.loreUiBindings = normalizeLoreUiBindings(draft.loreUiBindings);
      const serverToken = validServerToken(data.updatedAt) ?? get().baseUpdatedAt;
      const pendingEdit = (data.pendingEdit ?? null) as WorldPendingEditSummary | null;
      const worldStatus = (data.status as string | null) ?? (data.isPublished ? "published" : "draft");
      const submittedForReviewAt = typeof data.submittedForReviewAt === "string" ? data.submittedForReviewAt : null;

      if (get().isDirty) {
        // The editor has unsaved edits. This used to BAIL (return early) — which
        // is the entire reason the agent's changes didn't appear until a reload
        // ("改完进去没变，过一天才变"). Instead, 3-way merge the server (agent's)
        // changes into the local draft: the agent's work shows immediately AND
        // the user's unsaved edits survive. Reuses the merge engine from #27.
        const { merged, conflicts } = mergeWorldDefinition(get()._baseSchema, get().worldDraft, draft);
        merged.entries = normalizeFolders(merged).world.entries;
        set({
          worldDraft: merged,
          // stays dirty — merged still carries the user's unsaved edits vs server
          _past: [],
          _future: [],
          canUndo: false,
          canRedo: false,
          pendingEdit,
          worldStatus,
          submittedForReviewAt,
          baseUpdatedAt: serverToken,
          _baseSchema: structuredClone(draft),
        });
        // Nothing failed here — the agent rewrote the draft under the creator
        // while they were looking at something else. That is news they could
        // not watch happen, so it gets the neutral notice pill, never the red
        // error one. (The STALE_WORLD save path below DID fail and keeps
        // feedback.error.)
        feedback.notice(
          conflicts.length > 0
            ? tr("editor:save.agentMergedConflictsNotice", "Merged — your version kept")
            : tr("editor:save.agentMergedNotice", "Merged with agent changes"),
        );
        return;
      }

      // Clean editor — just take server truth so the agent's changes appear.
      set({
        worldDraft: draft,
        isDirty: false,
        _past: [],
        _future: [],
        canUndo: false,
        canRedo: false,
        pendingEdit,
        worldStatus,
        submittedForReviewAt,
        baseUpdatedAt: serverToken,
        _baseSchema: structuredClone(draft),
      });
    } catch {
      // Silent — this is a best-effort background refresh
    }
  },

  refreshWorldStatus: async () => {
    const { serverWorldId } = get();
    if (!serverWorldId) return;
    try {
      // preview=true returns the lean row (status/isPublished, no multi-MB schema).
      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}?preview=true&_t=${Date.now()}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const { data } = await res.json();
      if (!data || data.id !== get().serverWorldId) return;
      set({
        worldStatus: (data.status as string | null) ?? (data.isPublished ? "published" : "draft"),
        worldIsPublished: !!data.isPublished,
        submittedForReviewAt: typeof data.submittedForReviewAt === "string" ? data.submittedForReviewAt : null,
      });
    } catch {
      // best-effort — the worlds-list refresh usually covers it
    }
  },

  submitPendingEdit: async () => {
    const { serverWorldId } = get();
    if (!serverWorldId) return false;
    try {
      // Submit the visible working copy, not an older saved draft. A save that
      // races with more typing leaves isDirty=true; require another click then.
      if (get().isDirty) {
        const saved = await get().saveDraft();
        if (!saved || get().isDirty || get().serverWorldId !== serverWorldId) return false;
      }
      if (get().serverWorldId !== serverWorldId || !get().pendingEdit) return false;
      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}/pending/submit`, {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The publishing rate limiter answers 429 with a Retry-After header.
        // Showing the generic "failed" toast here made throttled creators
        // (bulk-updating a big catalog) think submit-for-review was broken.
        if (res.status === 429 || (body as { code?: string })?.code === "RATE_LIMITED") {
          const headerSeconds = Number(res.headers.get("Retry-After"));
          const bodySeconds = Number(/\d+/.exec((body as { error?: string })?.error ?? "")?.[0]);
          const seconds = headerSeconds > 0 ? headerSeconds : bodySeconds > 0 ? bodySeconds : 3600;
          feedback.error(
            tr("editor:review.submitRateLimited", "Too many submissions — wait {{minutes}} min", {
              minutes: Math.max(1, Math.ceil(seconds / 60)),
            }),
          );
          return false;
        }
        feedback.error(tr("editor:review.submitFailed", "Couldn't submit for review"));
        return false;
      }
      const data = (body as { data?: { autoApproved?: boolean; pendingEdit?: WorldPendingEditSummary | null } })?.data;
      if (get().serverWorldId !== serverWorldId) return true;
      set({ pendingEdit: data?.pendingEdit ?? null });
      // Auto-approval changes the live row's version. Refresh that token and
      // the working-copy baseline, preserving any typing during the request.
      await get().refreshWorldSchema();
      useWorldsStore.getState().invalidate();
      useWorldsStore.getState().fetchWorlds();
      // No confirmation needed: setting pendingEdit re-renders the review chip
      // as "In review" (or back to plain Publish when a trusted creator's edit
      // auto-approved), and its panel explains what happens next.
      return true;
    } catch {
      feedback.error(tr("editor:review.submitFailed", "Couldn't submit for review"));
      return false;
    }
  },

  withdrawPendingEdit: async () => {
    const { serverWorldId } = get();
    if (!serverWorldId) return false;
    try {
      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}/pending/withdraw`, {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        feedback.error(tr("editor:review.withdrawFailed", "Couldn't withdraw the submission"));
        return false;
      }
      // The chip flips out of "In review" on its own — nothing to announce.
      set({ pendingEdit: ((body as { data?: { pendingEdit?: WorldPendingEditSummary | null } })?.data?.pendingEdit ?? null) });
      return true;
    } catch {
      feedback.error(tr("editor:review.withdrawFailed", "Couldn't withdraw the submission"));
      return false;
    }
  },

  loadWorldFromData: (data) => {
    editorSession++;
    retireRecoveryOffer();
    loadAbort?.abort();
    const schema = (data.schema ?? {}) as unknown as WorldDefinition;
    const rawSchema = data.schema as Record<string, unknown> | undefined;

    const rawDraft: WorldDefinition = {
      id: schema.id || data.id,
      version: schema.version || "1.0.0",
      // DB name first — same rule as loadWorld (see comment there).
      name: data.name || schema.name || "",
      description: schema.description || data.description || "",
      author: schema.author || "",
      avatar: data.thumbnailUrl || schema.avatar,
      coverCrop: schema.coverCrop,
      galleryCoverCrop: schema.galleryCoverCrop,
      entries: schema.entries || [],
      variables: normalizeVariableIds(schema.variables || []),
      rules: schema.rules || [],
      reactions: schema.reactions || [],
      characters: schema.characters,
      components: schema.components || [],
      uiBlueprint: schema.uiBlueprint,
      audioTracks: schema.audioTracks || [],
      bgmPlaylist: schema.bgmPlaylist,
      conditionalBGM: schema.conditionalBGM,
      lorebookEntries: schema.lorebookEntries,
      customUI: schema.customUI || [],
      // Pass deprecated v18 fields through for migrateV18ToV19
      ...(rawSchema?.customComponents ? { customComponents: rawSchema.customComponents } : {}),
      ...(rawSchema?.messageRenderer ? { messageRenderer: rawSchema.messageRenderer } : {}),
      customTags: schema.customTags || [],
      entryFolders: schema.entryFolders,
      editorMode: schema.editorMode,
      rootComponent: schema.rootComponent,
      loreUiBindings: normalizeLoreUiBindings(schema.loreUiBindings),
      worldbooks: schema.worldbooks ?? [],
      settings: {
        maxTokens: schema.settings?.maxTokens ?? 12000,
        maxContext: schema.settings?.maxContext ?? 200000,
        temperature: schema.settings?.temperature ?? 1.0,
        topP: schema.settings?.topP ?? 1,
        frequencyPenalty: schema.settings?.frequencyPenalty ?? 0,
        presencePenalty: schema.settings?.presencePenalty ?? 0,
        topK: schema.settings?.topK,
        minP: schema.settings?.minP,
        playerName: schema.settings?.playerName ?? "User",
        systemPrompt: schema.settings?.systemPrompt,
        greeting: schema.settings?.greeting,
        lorebookScanDepth: schema.settings?.lorebookScanDepth ?? 2,
        lorebookRecursionDepth: schema.settings?.lorebookRecursionDepth ?? 0,
        layoutMode: schema.settings?.layoutMode,
        uiMode: schema.settings?.uiMode,
        ...((rawSchema?.settings as any)?.fullScreenComponent !== undefined
          ? { fullScreenComponent: (rawSchema!.settings as any).fullScreenComponent }
          : {}),
      },
    } as WorldDefinition;

    const draft = migrateWorldDefinition(rawDraft);
    draft.entries = normalizePositions(draft.entries);
    // Heal dangling entry→folder refs so orphaned entries render (don't vanish).
    draft.entries = normalizeFolders(draft).world.entries;
    draft.loreUiBindings = normalizeLoreUiBindings(draft.loreUiBindings);

    set({
      worldDraft: draft,
      serverWorldId: data.id,
      saving: false,
      isDirty: false,
      activeSection: "entries",
      loadingWorld: false,
      _past: [],
      _future: [],
      canUndo: false,
      canRedo: false,
      _pendingServerRefresh: false,
      // Imported/provided data carries no server updatedAt — guard stays off
      // until the first save (POST) or a refresh re-syncs the token.
      baseUpdatedAt: null,
      _baseSchema: structuredClone(draft),
    });
  },

  setActiveSection: (section) => set({ activeSection: section }),

  customUiTab: "code",
  setCustomUiTab: (tab) => set({ customUiTab: tab }),

  setField: (key, value) => {
    set((s) => {
      const draft = { ...s.worldDraft, [key]: value };
      return commitDraft(s, draft);
    });
  },

  setSettings: (key, value) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        settings: { ...s.worldDraft.settings, [key]: value },
      };
      return commitDraft(s, draft);
    });
  },

  addEntry: (role = "custom", section = "system-presets", placement) => {
    set((s) => {
      const folder = placement?.folderId
        ? s.worldDraft.entryFolders?.find((f) => f.id === placement.folderId)
        : undefined;
      if (placement?.folderId && !folder) return s;
      section = folder?.section ?? section;
      const defaults = deriveSectionDefaults(section);

      const sectionEntries = s.worldDraft.entries.filter((e) => e.section === section);
      const maxPosition = sectionEntries.reduce((max, e) => Math.max(max, e.position ?? 0), -1);

      const newEntry: WorldEntry = {
        id: crypto.randomUUID(),
        name: "New Entry",
        content: placement?.content ?? "",
        folderId: folder?.id,
        worldbookId: folder ? folder.worldbookId : placement?.worldbookId,
        role,
        alwaysSend: defaults.alwaysSend,
        keywords: [],
        conditions: [],
        conditionLogic: "all",
        enabled: true,
        matchWholeWords: false,
        secondaryKeywords: [],
        secondaryKeywordLogic: "AND_ANY",
        preventRecursion: false,
        excludeRecursion: false,
        position: maxPosition + 1,
        section,
        tags: [],
        depth: defaults.depth,
      };
      const draft = {
        ...s.worldDraft,
        entries: [...s.worldDraft.entries, newEntry],
      };
      return commitDraft(s, draft);
    });
  },

  updateEntry: (id, updates) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        entries: s.worldDraft.entries.map((e) => {
          if (e.id !== id) return e;
          const next = { ...e, ...updates };
          const folderWasSet = Object.prototype.hasOwnProperty.call(updates, "folderId");
          const scopeOrSectionChanged =
            Object.prototype.hasOwnProperty.call(updates, "worldbookId") ||
            Object.prototype.hasOwnProperty.call(updates, "section");

          if (folderWasSet && next.folderId) {
            const folder = (s.worldDraft.entryFolders ?? []).find((f) => f.id === next.folderId);
            if (!folder) return { ...next, folderId: undefined };
            // Folder membership is atomic: joining a folder also joins its book
            // and section, so a drag can never create a cross-book hierarchy.
            return { ...next, worldbookId: folder.worldbookId, section: folder.section };
          }

          if (next.folderId && scopeOrSectionChanged) {
            const folder = (s.worldDraft.entryFolders ?? []).find((f) => f.id === next.folderId);
            if (
              !folder ||
              (folder.worldbookId ?? undefined) !== (next.worldbookId ?? undefined) ||
              folder.section !== next.section
            ) {
              return { ...next, folderId: undefined };
            }
          }
          return next;
        }),
      };
      return commitDraft(s, draft);
    });
  },

  duplicateEntry: (id, copySuffix = "copy") => {
    const source = get().worldDraft.entries.find((e) => e.id === id);
    if (!source) return null;
    const newId = crypto.randomUUID();
    set((s) => {
      const index = s.worldDraft.entries.findIndex((e) => e.id === id);
      if (index === -1) return s;
      const src = s.worldDraft.entries[index]!;
      // Three identity links a copy must NOT inherit:
      //  presetId        — the copy is user-authored, not an official preset
      //  pairId          — pairing is 1:1 (AI summary ↔ player text); a third
      //                    member breaks editor navigation between the pair
      //  bundleInstallId — else removeInstalledBundle() would delete the user's
      //                    own copy along with the bundle it was cloned from
      const { presetId: _preset, pairId: _pair, bundleInstallId: _bundle, ...rest } = src;
      const copy: WorldEntry = {
        ...structuredClone(rest),
        id: newId,
        name: nextCopyName(src.name, s.worldDraft.entries, copySuffix),
        // +0.5 lands the copy directly under its source instead of at the end
        // of a 76-entry list; normalizePositions renumbers back to dense ints.
        position: (src.position ?? 0) + 0.5,
      };
      const entries = [...s.worldDraft.entries];
      entries.splice(index + 1, 0, copy);
      const draft = { ...s.worldDraft, entries: normalizePositions(entries) };
      return commitDraft(s, draft);
    });
    return newId;
  },

  removeEntry: (id) => {
    set((s) => {
      const filtered = s.worldDraft.entries.filter((e) => e.id !== id);
      const loreUiBindings = normalizeLoreUiBindings(s.worldDraft.loreUiBindings).filter(
        (b) => b.entryId !== id,
      );
      const draft = {
        ...s.worldDraft,
        entries: normalizePositions(filtered),
        loreUiBindings,
      };
      return commitDraft(s, draft);
    });
  },

  // Worldbook actions (lore modules). Activation is a pure function of game
  // state (variables/conditions) — see engine filterEntriesByActiveWorldbooks —
  // so the active set is identical on server + client and survives revert.
  addWorldbook: (name) => {
    set((s) => {
      const existing = s.worldDraft.worldbooks ?? [];
      const wb: Worldbook = {
        id: crypto.randomUUID(),
        name: name ?? `Worldbook ${existing.length + 1}`,
        activation: { mode: "always" },
        order: existing.length,
      };
      const draft = { ...s.worldDraft, worldbooks: [...existing, wb] };
      return commitDraft(s, draft);
    });
  },

  updateWorldbook: (id, patch) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        worldbooks: (s.worldDraft.worldbooks ?? []).map((w) =>
          w.id === id ? { ...w, ...patch } : w,
        ),
      };
      return commitDraft(s, draft);
    });
  },

  removeWorldbook: (id) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        worldbooks: (s.worldDraft.worldbooks ?? []).filter((w) => w.id !== id),
        // Orphaned entries fall back to the always-on Core book.
        entries: s.worldDraft.entries.map((e) =>
          e.worldbookId === id ? { ...e, worldbookId: undefined } : e,
        ),
        // Folders follow their entries back to Main/Core so deleting a book
        // preserves the creator's organization instead of leaving bad refs.
        entryFolders: (s.worldDraft.entryFolders ?? []).map((folder) =>
          folder.worldbookId === id ? { ...folder, worldbookId: undefined } : folder,
        ),
      };
      return commitDraft(s, draft);
    });
  },

  setEntryWorldbook: (entryId, worldbookId) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        entries: s.worldDraft.entries.map((e) =>
          e.id === entryId && (e.worldbookId ?? undefined) !== (worldbookId ?? undefined)
            ? { ...e, worldbookId, folderId: undefined }
            : e,
        ),
      };
      return commitDraft(s, draft);
    });
  },

  reorderEntries: (entryIds) => {
    set((s) => {
      // Assign per-section positions ONLY to the passed ids (dense 0..n in the
      // given order). Entries NOT listed keep their current position — a drag
      // inside one filtered view (a single book, a tag filter, the greeting
      // tabs) must never renumber entries outside that view. Callers pass the
      // complete intended order for whatever slice they own.
      const entryMap = new Map(s.worldDraft.entries.map((e) => [e.id, e]));
      const newPos = new Map<string, number>();
      const counters: Record<string, number> = {};
      for (const id of entryIds) {
        const entry = entryMap.get(id);
        if (!entry) continue;
        const pos = counters[entry.section] ?? 0;
        counters[entry.section] = pos + 1;
        newPos.set(id, pos);
      }
      const entries = s.worldDraft.entries.map((entry) => {
        const pos = newPos.get(entry.id);
        return pos === undefined || pos === entry.position ? entry : { ...entry, position: pos };
      });
      const draft = { ...s.worldDraft, entries };
      return commitDraft(s, draft);
    });
  },

  addFolder: (section, name = "New Folder", worldbookId) => {
    set((s) => {
      const existingFolders = (s.worldDraft.entryFolders ?? []).filter(
        (f) => f.section === section && (f.worldbookId ?? undefined) === (worldbookId ?? undefined),
      );
      const maxOrder = existingFolders.reduce((max, f) => Math.max(max, f.order), -1);
      const newFolder: EntryFolder = {
        id: crypto.randomUUID(),
        name,
        section,
        order: maxOrder + 1,
        worldbookId,
      };
      const draft = {
        ...s.worldDraft,
        entryFolders: [...(s.worldDraft.entryFolders ?? []), newFolder],
      };
      return commitDraft(s, draft);
    });
  },

  removeFolder: (folderId) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        entryFolders: (s.worldDraft.entryFolders ?? []).filter((f) => f.id !== folderId),
        entries: s.worldDraft.entries.map((e) =>
          e.folderId === folderId ? { ...e, folderId: undefined } : e
        ),
      };
      return commitDraft(s, draft);
    });
  },

  renameFolder: (folderId, name) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        entryFolders: (s.worldDraft.entryFolders ?? []).map((f) =>
          f.id === folderId ? { ...f, name } : f
        ),
      };
      return commitDraft(s, draft);
    });
  },

  moveFolder: (folderId, newSection) => {
    set((s) => {
      const folder = (s.worldDraft.entryFolders ?? []).find((f) => f.id === folderId);
      if (!folder || folder.section === newSection) return s;
      const existingFolders = (s.worldDraft.entryFolders ?? []).filter(
        (f) =>
          f.section === newSection &&
          (f.worldbookId ?? undefined) === (folder.worldbookId ?? undefined),
      );
      const maxOrder = existingFolders.reduce((max, f) => Math.max(max, f.order), -1);
      const draft = {
        ...s.worldDraft,
        entryFolders: (s.worldDraft.entryFolders ?? []).map((f) =>
          f.id === folderId ? { ...f, section: newSection, order: maxOrder + 1 } : f
        ),
        entries: s.worldDraft.entries.map((e) => {
          if (e.folderId !== folderId) return e;
          // Don't override greeting entries
          if (e.role === "greeting") return { ...e, section: newSection };
          const defaults = deriveSectionDefaultsForEntry(e, newSection);
          return { ...e, section: newSection, ...defaults };
        }),
      };
      return commitDraft(s, draft);
    });
  },

  addCustomTag: (tagName) => {
    set((s) => {
      const existing = s.worldDraft.customTags ?? [];
      if (existing.includes(tagName)) return s;
      const draft = {
        ...s.worldDraft,
        customTags: [...existing, tagName],
      };
      return commitDraft(s, draft);
    });
  },

  removeCustomTag: (tagName) => {
    set((s) => {
      const nextColors = { ...(s.worldDraft.customTagColors ?? {}) };
      delete nextColors[tagName];
      const draft = {
        ...s.worldDraft,
        customTags: (s.worldDraft.customTags ?? []).filter((t) => t !== tagName),
        customTagColors: Object.keys(nextColors).length > 0 ? nextColors : undefined,
        entries: s.worldDraft.entries.map((e) =>
          e.tags?.includes(tagName)
            ? { ...e, tags: e.tags.filter((t) => t !== tagName) }
            : e
        ),
      };
      return commitDraft(s, draft);
    });
  },

  renameCustomTag: (oldName, newName) => {
    set((s) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === oldName) return s;
      const oldColors = s.worldDraft.customTagColors ?? {};
      const nextColors: Record<string, string> = {};
      for (const [k, v] of Object.entries(oldColors)) {
        nextColors[k === oldName ? trimmed : k] = v;
      }
      const draft = {
        ...s.worldDraft,
        customTags: (s.worldDraft.customTags ?? []).map((t) =>
          t === oldName ? trimmed : t
        ),
        customTagColors: Object.keys(nextColors).length > 0 ? nextColors : undefined,
        entries: s.worldDraft.entries.map((e) =>
          e.tags?.includes(oldName)
            ? { ...e, tags: e.tags.map((t) => (t === oldName ? trimmed : t)) }
            : e
        ),
      };
      return commitDraft(s, draft);
    });
  },

  setCustomTagColor: (tagName, color) => {
    set((s) => {
      const next = { ...(s.worldDraft.customTagColors ?? {}) };
      if (color === null) {
        delete next[tagName];
      } else {
        next[tagName] = color;
      }
      const draft = {
        ...s.worldDraft,
        customTagColors: Object.keys(next).length > 0 ? next : undefined,
      };
      return commitDraft(s, draft);
    });
  },

  addVariable: () => {
    set((s) => {
      const newVar: Variable = {
        id: crypto.randomUUID(),
        name: "New Variable",
        type: "number",
        defaultValue: 0,
        description: "",
      };
      const draft = {
        ...s.worldDraft,
        variables: [...s.worldDraft.variables, newVar],
      };
      return commitDraft(s, draft);
    });
  },

  updateVariableAt: (index, updates) => {
    set((s) => {
      const current = s.worldDraft.variables[index];
      if (!current) return {};
      const next = { ...current, ...updates };
      if (updates.id !== undefined) {
        const trimmed = updates.id.trim();
        if (!trimmed) {
          // An empty id would break every {{id}} reference — keep the old one.
          next.id = current.id;
        } else {
          const taken = new Set(
            s.worldDraft.variables.filter((_, i) => i !== index).map((v) => v.id)
          );
          next.id = dedupeVariableId(trimmed, taken);
        }
      }
      const draft = {
        ...s.worldDraft,
        variables: s.worldDraft.variables.map((v, i) => (i === index ? next : v)),
      };
      return commitDraft(s, draft);
    });
  },

  ensureVariableByName: (name, type, defaultValue, internal) => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    const existing = get().worldDraft.variables.find((v) => v.name.trim() === trimmed);
    if (existing) return existing.id;
    const newVar: Variable = {
      id: crypto.randomUUID(),
      name: trimmed,
      type,
      defaultValue,
      description: "",
      ...(internal ? { internal: true } : {}),
    };
    set((s) => commitDraft(s, {
      ...s.worldDraft,
      variables: [...s.worldDraft.variables, newVar],
    }));
    return newVar.id;
  },

  removeVariableAt: (index) => {
    set((s) => {
      if (!s.worldDraft.variables[index]) return {};
      const draft = {
        ...s.worldDraft,
        variables: s.worldDraft.variables.filter((_, i) => i !== index),
      };
      return commitDraft(s, draft);
    });
  },

  addComponent: (type = "stat-bar" as GameComponent["type"]) => {
    set((s) => {
      const newComp: GameComponent = {
        id: crypto.randomUUID(),
        type,
        name: "New Component",
        order: s.worldDraft.components.length,
        visible: true,
        placement: "header",
        config: defaultComponentConfigByType(type),
      } as GameComponent;
      const draft = {
        ...s.worldDraft,
        components: [...s.worldDraft.components, newComp],
      };
      return commitDraft(s, draft);
    });
  },

  updateComponent: (id, updates) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        components: s.worldDraft.components.map((c) =>
          c.id === id ? ({ ...c, ...updates } as GameComponent) : c
        ),
      };
      return commitDraft(s, draft);
    });
  },

  removeComponent: (id) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        components: s.worldDraft.components.filter((c) => c.id !== id),
      };
      return commitDraft(s, draft);
    });
  },

  reorderComponents: (componentIds) => {
    set((s) => {
      const compMap = new Map(s.worldDraft.components.map((c) => [c.id, c]));
      const reordered = componentIds
        .map((id, i) => {
          const comp = compMap.get(id);
          return comp ? { ...comp, order: i } : null;
        })
        .filter(Boolean) as GameComponent[];
      const draft = { ...s.worldDraft, components: reordered };
      return commitDraft(s, draft);
    });
  },

  addAudioTrack: () => {
    set((s) => {
      const newTrack: AudioTrack = {
        id: crypto.randomUUID(),
        name: "New Track",
        type: "bgm",
        url: "",
        loop: true,
        volume: 1,
      };
      const draft = {
        ...s.worldDraft,
        audioTracks: [...(s.worldDraft.audioTracks ?? []), newTrack],
      };
      return commitDraft(s, draft);
    });
  },

  updateAudioTrack: (id, updates) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        audioTracks: (s.worldDraft.audioTracks ?? []).map((t) =>
          t.id === id ? { ...t, ...updates } : t
        ),
      };
      return commitDraft(s, draft);
    });
  },

  removeAudioTrack: (id) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        audioTracks: (s.worldDraft.audioTracks ?? []).filter(
          (t) => t.id !== id
        ),
      };
      return commitDraft(s, draft);
    });
  },

  setBgmPlaylist: (playlist) => {
    set((s) => {
      const draft = { ...s.worldDraft, bgmPlaylist: playlist };
      return commitDraft(s, draft);
    });
  },

  updateBgmPlaylist: (updates) => {
    set((s) => {
      const current = s.worldDraft.bgmPlaylist ?? {
        tracks: [],
        playMode: "loop" as const,
        autoPlay: true,
        waitForFirstMessage: false,
        gapSeconds: 0,
      };
      const draft = { ...s.worldDraft, bgmPlaylist: { ...current, ...updates } };
      return commitDraft(s, draft);
    });
  },

  addConditionalBGM: () => {
    set((s) => {
      const newItem = {
        id: crypto.randomUUID(),
        name: "New Conditional BGM",
        triggerType: "variable" as const,
        conditions: [],
        conditionLogic: "all" as const,
        targetTrackId: "",
        priority: 0,
        fadeInDuration: 1,
        fadeOutDuration: 1,
        stopPreviousBGM: true,
        fallback: "default",
      };
      const draft = {
        ...s.worldDraft,
        conditionalBGM: [...(s.worldDraft.conditionalBGM ?? []), newItem],
      };
      return commitDraft(s, draft);
    });
  },

  updateConditionalBGM: (id, updates) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        conditionalBGM: (s.worldDraft.conditionalBGM ?? []).map((c) =>
          c.id === id ? { ...c, ...updates } : c
        ),
      };
      return commitDraft(s, draft);
    });
  },

  removeConditionalBGM: (id) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        conditionalBGM: (s.worldDraft.conditionalBGM ?? []).filter(
          (c) => c.id !== id
        ),
      };
      return commitDraft(s, draft);
    });
  },

  // ── Root Component ──

  updateRootComponent: (updates) => {
    set((s) => {
      if (!s.worldDraft.rootComponent) return s;
      const draft = {
        ...s.worldDraft,
        rootComponent: {
          ...s.worldDraft.rootComponent,
          ...updates,
          updatedAt: new Date().toISOString(),
        },
      };
      return commitDraft(s, draft);
    });
  },

  addRule: (variableId?: string) => {
    set((s) => {
      const newRule: Rule = {
        id: crypto.randomUUID(),
        name: "New Rule",
        description: "",
        trigger: { type: "state-change" },
        conditions: [],
        conditionLogic: "all",
        actions: variableId
          ? [{ type: "modify-variable", variableId, operation: "set", value: 0 }]
          : [],
        priority: s.worldDraft.rules.length,
        enabled: true,
      };
      const draft = {
        ...s.worldDraft,
        rules: [...s.worldDraft.rules, newRule],
      };
      return commitDraft(s, draft);
    });
  },

  updateRule: (id, updates) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        rules: s.worldDraft.rules.map((r) =>
          r.id === id ? { ...r, ...updates } : r
        ),
      };
      return commitDraft(s, draft);
    });
  },

  removeRule: (id) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        rules: s.worldDraft.rules.filter((r) => r.id !== id),
      };
      return commitDraft(s, draft);
    });
  },

  reorderRules: (ruleIds) => {
    set((s) => {
      const ruleMap = new Map(s.worldDraft.rules.map((r) => [r.id, r]));
      const reordered = ruleIds
        .map((id, i) => {
          const rule = ruleMap.get(id);
          return rule ? { ...rule, priority: i } : null;
        })
        .filter(Boolean) as Rule[];
      const draft = { ...s.worldDraft, rules: reordered };
      return commitDraft(s, draft);
    });
  },

  addReaction: () => {
    set((s) => {
      const newReaction: Reaction = {
        id: crypto.randomUUID(),
        name: "New Reaction",
        description: "",
        when: { eventType: "turn:complete" },
        conditions: [],
        conditionLogic: "all",
        then: [],
        priority: 0,
        enabled: true,
      };
      const editableDraft = materializeBehaviors(s.worldDraft);
      const existing = editableDraft.reactions ?? [];
      const draft = {
        ...editableDraft,
        reactions: [...existing, newReaction],
      };
      return commitDraft(s, draft);
    });
  },

  updateReaction: (id, updates) => {
    set((s) => {
      const editableDraft = materializeBehaviors(s.worldDraft);
      const existing = editableDraft.reactions ?? [];
      const draft = {
        ...editableDraft,
        reactions: existing.map((r) =>
          r.id === id ? { ...r, ...updates } : r
        ),
      };
      return commitDraft(s, draft);
    });
  },

  removeReaction: (id) => {
    set((s) => {
      const editableDraft = materializeBehaviors(s.worldDraft);
      const existing = editableDraft.reactions ?? [];
      const draft = {
        ...editableDraft,
        reactions: existing.filter((r) => r.id !== id),
      };
      return commitDraft(s, draft);
    });
  },

  loadTemplate: (template) => {
    editorSession++;
    loadAbort?.abort();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    const draft = template.build();
    // Ensure all new worlds from templates have a rootComponent
    if (!draft.rootComponent) {
      draft.rootComponent = createDefaultRootComponent();
    }
    // Dedup the template's default name against the user's existing library so
    // forgotten renames don't pile up as identical "Character Chat" entries.
    // Uses whatever's already in worldsStore (refreshed when the library page
    // was last visited) — good enough since worlds are user-scoped + small.
    const taken = new Set(
      useWorldsStore.getState().worlds.map((w) => w.name)
    );
    if (taken.has(draft.name)) {
      let n = 2;
      while (taken.has(`${draft.name} (${n})`)) n++;
      draft.name = `${draft.name} (${n})`;
    }
    if (import.meta.env.DEV && draft.entries.length === 0) {
      console.warn("[editor] loadTemplate produced 0 entries — template may have failed silently", template.id);
    }
    set({
      worldDraft: draft,
      serverWorldId: null,
      saving: false,
      loadingWorld: false,
      baseUpdatedAt: null,
      _baseSchema: null,
      isDirty: false,
      activeSection: "entries",
      _past: [],
      _future: [],
      canUndo: false,
      canRedo: false,
      galleryImages: [],
      announcement: "",
      approxTime: "",
      tags: [],
      worldIsPublished: false,
      // Same creator-locale default as `createNew` — templates are also a
      // fresh-card path, so initialize the picker rather than leaving NULL.
      language: contentLanguage(i18n.language),
      languageGroupId: null,
      variantLabel: null,      variants: [],
      variantsLoading: false,
    });
    localStorage.removeItem(DRAFT_KEY);
  },

  loadWorldDefinition: (def, options) => {
    retireRecoveryOffer();
    loadAbort?.abort();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    const preserveServerState = options?.preserveServerState ?? false;
    if (!preserveServerState) editorSession++;
    const prev = get();
    const base = createEmptyWorld();
    const rawDraft: WorldDefinition = {
      ...base,
      ...def,
      // When updating an existing world in place, keep the existing world id
      // so persisted references (assets, sessions, etc.) stay consistent.
      id: preserveServerState
        ? prev.worldDraft.id || def.id || base.id
        : def.id || base.id,
      version: def.version || base.version,
      name: def.name || base.name,
      description: def.description || base.description,
      author: def.author || base.author,
      entries: def.entries ?? base.entries,
      variables: normalizeVariableIds(def.variables ?? base.variables),
      rules: def.rules ?? base.rules,
      components: def.components ?? base.components,
      audioTracks: def.audioTracks ?? base.audioTracks,
      customUI: def.customUI ?? base.customUI,
      rootComponent:
        def.rootComponent ??
        ((def.customUI && def.customUI.length > 0)
          ? undefined
          : createDefaultRootComponent()),
      settings: {
        ...base.settings,
        ...(def.settings ?? {}),
      },
    };
    const draft = migrateWorldDefinition(rawDraft);
    draft.entries = normalizePositions(draft.entries);
    // Heal dangling entry→folder refs so orphaned entries render (don't vanish).
    draft.entries = normalizeFolders(draft).world.entries;
    set({
      worldDraft: draft,
      serverWorldId: preserveServerState ? prev.serverWorldId : null,
      saving: preserveServerState ? prev.saving : false,
      loadingWorld: false,
      baseUpdatedAt: preserveServerState ? prev.baseUpdatedAt : null,
      // Keep the server ancestor for an in-place update; new card → no ancestor.
      _baseSchema: preserveServerState ? prev._baseSchema : null,
      isDirty: true,
      activeSection: "entries",
      _past: [],
      _future: [],
      canUndo: false,
      canRedo: false,
      galleryImages: preserveServerState ? prev.galleryImages : [],
      announcement: preserveServerState ? prev.announcement : "",
      approxTime: preserveServerState ? prev.approxTime : "",
      tags: preserveServerState ? prev.tags : [],
      worldIsPublished: preserveServerState ? prev.worldIsPublished : false,
      worldStatus: preserveServerState ? prev.worldStatus : null,
      submittedForReviewAt: preserveServerState ? prev.submittedForReviewAt : null,
      pendingEdit: preserveServerState ? prev.pendingEdit : null,
      language: def.language ?? (preserveServerState ? prev.language : null),
      languageGroupId: preserveServerState ? prev.languageGroupId : null,
      variantLabel: preserveServerState ? prev.variantLabel : null,
      variants: preserveServerState ? prev.variants : [],
      variantsLoading: false,
    });
    localStorage.removeItem(DRAFT_KEY);
  },

  applyImportedCover: async (blob) => {
    // The thumbnail endpoint needs an owned, server-side world. Create one
    // first if this is a fresh import (mirrors the manual cover-upload flow).
    let id = get().serverWorldId;
    if (!id) {
      if (!get().worldDraft.name) {
        get().setField("name", "Untitled World");
      }
      await get().saveDraft();
      id = get().serverWorldId;
    }
    if (!id) return; // save failed — saveDraft already surfaced the error

    try {
      const file = new File([blob], "cover.png", { type: "image/png" });
      const data = await uploadAssetWithPresignedUrl<{ thumbnailUrl: string }>({
        file,
        preferredType: "image",
        resizeImageMaxDimension: 2048, // card cover — don't store the full original
        prepareUrl: `${apiBase}/api/worlds/${id}/thumbnail`,
        registerUrl: `${apiBase}/api/worlds/${id}/thumbnail/confirm`,
        registerBody: ({ key }) => ({ key }),
      });
      get().setField("avatar", data.thumbnailUrl);
    } catch (err) {
      console.error("Imported cover upload failed:", err);
      feedback.error(tr("editor:overview.importCoverFailed", "Couldn't use the card image as the cover"));
    }
  },

  importBundle: (bundle, sourceBundleId) => {
    set((s) => {
      const installId = crypto.randomUUID();
      const colorKey = nextBundleColorKey(s.worldDraft.installedBundles?.length ?? 0);
      const existingVarIds = new Set(s.worldDraft.variables.map((v) => v.id));
      const existingVarNames = new Map(
        s.worldDraft.variables.map((v) => [v.name.toLowerCase(), v.id])
      );

      // Build variable ID remap: old bundle var ID → new ID in this world
      const varIdMap = new Map<string, string>();
      const newVars: Variable[] = [];

      for (const bv of bundle.variables) {
        if (existingVarIds.has(bv.id)) {
          // Same ID already exists → skip, map to itself
          varIdMap.set(bv.id, bv.id);
        } else if (existingVarNames.has(bv.name.toLowerCase())) {
          // Name conflict → create with new ID and rename
          const newId = `var_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          let newName = bv.name;
          let suffix = 1;
          while (existingVarNames.has(newName.toLowerCase()) ||
            newVars.some((v) => v.name.toLowerCase() === newName.toLowerCase())) {
            newName = `${bv.name} (${suffix++})`;
          }
          varIdMap.set(bv.id, newId);
          newVars.push({ ...bv, id: newId, name: newName });
        } else {
          // No conflict → keep as-is
          varIdMap.set(bv.id, bv.id);
          newVars.push(bv);
        }
      }

      // Remap variableId references in a condition/effect
      const remapVarId = (id: string) => varIdMap.get(id) ?? id;

      // New worldbooks — fresh ids; remap each activation condition's variableId
      // through the same var remap so conditional activation survives import.
      const worldbookIdMap = new Map<string, string>();
      const newWorldbooks = (bundle.worldbooks ?? []).map((wb) => {
        const newId = crypto.randomUUID();
        worldbookIdMap.set(wb.id, newId);
        const activation =
          wb.activation.mode === "conditions"
            ? {
                ...wb.activation,
                conditions: wb.activation.conditions.map((c) => ({
                  ...c,
                  variableId: remapVarId(c.variableId),
                })),
              }
            : wb.activation;
        return { ...wb, id: newId, activation, sourceBundleId: installId };
      });
      // Entry membership: remap to the new worldbook id, or fall back to Core
      // (undefined) if the bundle didn't include that worldbook.
      const remapWorldbookId = (id: string | undefined): string | undefined =>
        id && worldbookIdMap.has(id) ? worldbookIdMap.get(id) : undefined;

      // New entries — always new UUIDs, build remap for toggle-entry actions.
      // Place imported entries at the TOP of the lorebook (below the current
      // minimum position) so freshly-imported, color-coded bundle content is
      // immediately visible rather than buried at the bottom. Order within the
      // bundle is preserved; positions sort first within each section.
      const minPosition = s.worldDraft.entries.reduce((min, e) => Math.min(min, e.position ?? 0), 0);
      const entryIdMap = new Map<string, string>();
      const newEntries = bundle.entries.map((e, i) => {
        const newId = crypto.randomUUID();
        entryIdMap.set(e.id, newId);
        return { ...e, id: newId, position: minPosition - bundle.entries.length + i };
      });

      // New rules — new UUIDs, build remap for toggle-rule actions
      const ruleIdMap = new Map<string, string>();
      for (const r of bundle.rules) {
        ruleIdMap.set(r.id, crypto.randomUUID());
      }
      const remapEntryId = (id: string) => entryIdMap.get(id) ?? id;
      const remapRuleId = (id: string) => ruleIdMap.get(id) ?? id;

      const newRules = bundle.rules.map((r, i) => ({
        ...r,
        id: ruleIdMap.get(r.id)!,
        priority: s.worldDraft.rules.length + i,
        conditions: r.conditions.map((c) => ({
          ...c,
          variableId: remapVarId(c.variableId),
        })),
        actions: (r.actions ?? []).map((a) => {
          if (a.type === "modify-variable") {
            return { ...a, variableId: remapVarId(a.variableId) };
          }
          if (a.type === "toggle-entry") {
            return { ...a, entryId: remapEntryId((a as unknown as { entryId: string }).entryId) };
          }
          if (a.type === "toggle-rule") {
            return { ...a, ruleId: remapRuleId((a as unknown as { ruleId: string }).ruleId) };
          }
          return a;
        }),
      }));

      // New reactions (behaviors) — new UUIDs, then rewrite every id-bearing
      // reference they hold (watched variable, conditions, effect targets and
      // operands) so they keep working against this world's ids.
      const reactionIdMap = new Map<string, string>();
      for (const r of bundle.reactions ?? []) {
        reactionIdMap.set(r.id, crypto.randomUUID());
      }
      const newReactions: Reaction[] = (bundle.reactions ?? []).map((r, i) => ({
        ...remapReactionReferences(r, {
          variableId: remapVarId,
          entryId: remapEntryId,
          reactionId: (id) => reactionIdMap.get(id) ?? id,
        }),
        id: reactionIdMap.get(r.id)!,
        priority: (s.worldDraft.reactions?.length ?? 0) + i,
      }));

      // Merge custom tags (deduplicate)
      const existingCustomTags = new Set(s.worldDraft.customTags ?? []);
      const newCustomTags = (bundle.customTags ?? []).filter((t) => !existingCustomTags.has(t));

      // Merge entry folders with new IDs and remapped book ownership. Legacy
      // bundles may contain one shared folder referenced by several books; split
      // it here just like the v20→v21 world migration does.
      const bundleFolderKey = (folderId: string, worldbookId?: string) =>
        `${folderId}\u0000${worldbookId ?? "\u0000core"}`;
      const folderIdMap = new Map<string, string>();
      const newFolders: EntryFolder[] = [];
      for (const folder of bundle.entryFolders ?? []) {
        const inferredScopes = new Set(
          bundle.entries
            .filter((entry) => entry.folderId === folder.id)
            .map((entry) => entry.worldbookId),
        );
        const scopes = folder.worldbookId
          ? [folder.worldbookId]
          : inferredScopes.size > 0
            ? [...inferredScopes]
            : [undefined];
        for (const sourceWorldbookId of scopes) {
          const newId = crypto.randomUUID();
          folderIdMap.set(bundleFolderKey(folder.id, sourceWorldbookId), newId);
          newFolders.push({
            ...folder,
            id: newId,
            worldbookId: remapWorldbookId(sourceWorldbookId),
          });
        }
      }

      // Remap folderId on entries + sync position/alwaysSend from section.
      // Entry conditions get the same variableId remap as rules/worldbooks —
      // without it, a name-conflict var rename leaves conditions pointing at
      // an id that doesn't exist in this world.
      const remappedEntries = newEntries.map((e) => {
        const base = {
          ...e,
          folderId: e.folderId ? folderIdMap.get(bundleFolderKey(e.folderId, e.worldbookId)) : undefined,
          worldbookId: remapWorldbookId(e.worldbookId),
          bundleInstallId: installId,
          conditions: (e.conditions ?? []).map((c) => ({
            ...c,
            variableId: remapVarId(c.variableId),
          })),
        };
        // Don't override greeting entries
        if (base.role === "greeting") return base;
        // Sync derived fields from section — the ForEntry variant keeps
        // alwaysSend=false on variable-bound entries (clobbering it was the
        // "imported bundle ignores its conditions / always sends" bug).
        if (base.section) {
          const defaults = deriveSectionDefaultsForEntry(base, base.section);
          return { ...base, ...defaults };
        }
        return base;
      });

      // Normalize the bundle's visual layer into a single rootComponent shape.
      // Post-v3 bundles carry `rootComponent` directly. Pre-v3 shapes shipped
      // customUI[] and/or messageRenderer/customComponents[] — we synthesize a
      // rootComponent from those using the same v19→v20 converter the world
      // migrator uses, so every import path converges on a single model.
      let bundleRoot = bundle.rootComponent ?? null;
      if (!bundleRoot) {
        const legacyCustomUI = [
          ...((bundle.customUI ?? []) as Array<{ id?: string; name?: string; surface: "message" | "app"; tsxCode?: string; language?: "tsx" | "html" | "markdown"; visible?: boolean; order?: number }>),
          ...(bundle.messageRenderer
            ? [{
                surface: "message" as const,
                tsxCode: bundle.messageRenderer.tsxCode,
                visible: true,
              }]
            : []),
          ...((bundle.customComponents ?? []).map((c, i) => ({
            surface: "app" as const,
            tsxCode: c.tsxCode,
            visible: c.visible ?? true,
            order: c.order ?? i,
          }))),
        ];
        if (legacyCustomUI.length > 0) {
          const files = customUIToRootFiles(legacyCustomUI);
          bundleRoot = {
            id: `${s.worldDraft.id}:root`,
            name: "Root",
            entryFile: "index.tsx",
            files,
            updatedAt: new Date().toISOString(),
          };
        }
      }

      // Always-compose merge that preserves the runtime invariant
      // `entryFile === "index.tsx"`. The user's own root code lives in
      // __user-root.tsx; bundles live under _bundles/{slug}/; index.tsx is an
      // auto-generated composer that mounts user-root + each bundle. This
      // means importing a bundle NEVER erases the user's content — their
      // previous index.tsx is migrated into __user-root.tsx on the first
      // import and left untouched on subsequent imports.
      let mergedRoot = s.worldDraft.rootComponent;
      let bundleSlug: string | undefined;
      if (bundleRoot) {
        const worldRoot = s.worldDraft.rootComponent ?? {
          id: `${s.worldDraft.id}:root`,
          name: "Root",
          entryFile: "index.tsx",
          files: { "index.tsx": DEFAULT_ROOT_ENTRY_TSX },
          updatedAt: new Date().toISOString(),
        };

        const currentIndex = worldRoot.files["index.tsx"] ?? DEFAULT_ROOT_ENTRY_TSX;
        const alreadyComposed = currentIndex.startsWith(COMPOSED_MARKER);

        const files: Record<string, string> = { ...worldRoot.files };

        // Ensure __user-root.tsx holds the user's own main UI. On first import
        // we migrate the current index.tsx content there. On later imports the
        // user's file is already in place — don't touch it.
        if (!alreadyComposed && files[USER_ROOT_PATH] === undefined) {
          files[USER_ROOT_PATH] = currentIndex;
        }

        // Pick a namespace slug for this bundle (bundle.name → kebab-slug,
        // fallback "bundle", suffix on collision).
        const baseSlug =
          (bundle.name || "bundle")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32) || "bundle";
        const takenFolders = new Set<string>();
        for (const fname of Object.keys(files)) {
          const m = fname.match(/^_bundles\/([^/]+)\//);
          if (m) takenFolders.add(m[1]);
        }
        let folder = baseSlug;
        let suffix = 2;
        while (takenFolders.has(folder)) {
          folder = `${baseSlug}-${suffix++}`;
        }
        bundleSlug = folder;

        // Copy bundle files into `_bundles/{folder}/`. Normalize the bundle's
        // own entry to index.tsx inside its folder so the composed index can
        // always import `./_bundles/{folder}/index`.
        const bundleEntry = bundleRoot.entryFile ?? "index.tsx";
        for (const [filename, code] of Object.entries(bundleRoot.files ?? {})) {
          const destName =
            filename === bundleEntry
              ? "index.tsx"
              : filename === "index.tsx"
              ? "__aux-index.tsx"
              : filename;
          files[`_bundles/${folder}/${destName}`] = code;
        }

        // Authoritative bundle-folder list (includes any previous imports).
        const folderSet = new Set<string>();
        for (const fname of Object.keys(files)) {
          const m = fname.match(BUNDLE_NS_RE);
          if (m) folderSet.add(m[1]);
        }
        const folderList = [...folderSet].sort();

        // Regenerate the composed index.tsx. entryFile stays "index.tsx".
        files["index.tsx"] = generateComposedIndex(folderList);

        mergedRoot = {
          ...worldRoot,
          entryFile: "index.tsx",
          files,
          updatedAt: new Date().toISOString(),
        };
      }

      const newAudioTracks = (bundle.audioTracks ?? []).map((t) => ({
        ...t,
        id: crypto.randomUUID(),
      }));

      // Record this import so the editor can color-code its content and offer
      // clean removal via Manage Bundles. originalHash lets us detect later edits.
      const record: InstalledBundle = {
        installId,
        sourceBundleId,
        name: bundle.name || "Bundle",
        slug: bundleSlug,
        colorKey,
        importedAt: new Date().toISOString(),
        originalHash: hashString(
          projectBundleContent({
            entries: remappedEntries,
            variables: newVars,
            rules: newRules,
            reactions: newReactions,
            audioTracks: newAudioTracks,
            files: bundleFilesFor(bundleSlug, mergedRoot?.files ?? {}),
          }),
        ),
        entryIds: remappedEntries.map((e) => e.id),
        variableIds: newVars.map((v) => v.id),
        ruleIds: newRules.map((r) => r.id),
        reactionIds: newReactions.map((r) => r.id),
        audioTrackIds: newAudioTracks.map((t) => t.id),
        folderIds: newFolders.map((f) => f.id),
        worldbookIds: newWorldbooks.map((w) => w.id),
      };

      const draft: WorldDefinition = {
        ...s.worldDraft,
        entries: [...s.worldDraft.entries, ...remappedEntries],
        variables: [...s.worldDraft.variables, ...newVars],
        rules: [...s.worldDraft.rules, ...newRules],
        // Stay undefined when neither side has behaviors, so importing a
        // reaction-free bundle doesn't flip a legacy world onto the modern
        // array (which would make the Behaviors editor stop compiling `rules`).
        reactions:
          newReactions.length > 0 || s.worldDraft.reactions
            ? [...(s.worldDraft.reactions ?? []), ...newReactions]
            : undefined,
        rootComponent: mergedRoot,
        customUI: s.worldDraft.customUI ?? [],
        audioTracks: [...(s.worldDraft.audioTracks ?? []), ...newAudioTracks],
        customTags: [...(s.worldDraft.customTags ?? []), ...newCustomTags],
        entryFolders: [...(s.worldDraft.entryFolders ?? []), ...newFolders],
        worldbooks: [...(s.worldDraft.worldbooks ?? []), ...newWorldbooks],
        installedBundles: [...(s.worldDraft.installedBundles ?? []), record],
      };

      return commitDraft(s, draft);
    });
  },

  removeInstalledBundle: (installId) => {
    set((s) => {
      const record = (s.worldDraft.installedBundles ?? []).find((b) => b.installId === installId);
      if (!record) return s;

      const entryIds = new Set(record.entryIds);
      const variableIds = new Set(record.variableIds);
      const ruleIds = new Set(record.ruleIds);
      const reactionIds = new Set(record.reactionIds ?? []);
      const audioIds = new Set(record.audioTrackIds);
      const folderIds = new Set(record.folderIds);
      const worldbookIds = new Set(record.worldbookIds ?? []);

      // Drop the bundle's UI files (if any) and regenerate the composed index.
      let rootComponent = s.worldDraft.rootComponent;
      if (record.slug && rootComponent) {
        const prefix = `_bundles/${record.slug}/`;
        const files: Record<string, string> = {};
        for (const [path, code] of Object.entries(rootComponent.files)) {
          if (!path.startsWith(prefix)) files[path] = code;
        }
        const folderSet = new Set<string>();
        for (const fname of Object.keys(files)) {
          const m = fname.match(BUNDLE_NS_RE);
          if (m) folderSet.add(m[1]);
        }
        files["index.tsx"] = generateComposedIndex([...folderSet].sort());
        rootComponent = { ...rootComponent, files, updatedAt: new Date().toISOString() };
      }

      const draft: WorldDefinition = {
        ...s.worldDraft,
        entries: s.worldDraft.entries.filter(
          (e) => e.bundleInstallId !== installId && !entryIds.has(e.id),
        ),
        variables: s.worldDraft.variables.filter((v) => !variableIds.has(v.id)),
        rules: s.worldDraft.rules.filter((r) => !ruleIds.has(r.id)),
        reactions: s.worldDraft.reactions?.filter((r) => !reactionIds.has(r.id)),
        audioTracks: (s.worldDraft.audioTracks ?? []).filter((t) => !audioIds.has(t.id)),
        entryFolders: (s.worldDraft.entryFolders ?? []).filter((f) => !folderIds.has(f.id)),
        worldbooks: (s.worldDraft.worldbooks ?? []).filter((w) => !worldbookIds.has(w.id)),
        rootComponent,
        installedBundles: (s.worldDraft.installedBundles ?? []).filter(
          (b) => b.installId !== installId,
        ),
      };

      return commitDraft(s, draft);
    });
  },

  isInstalledBundleModified: (installId) => {
    const { worldDraft } = get();
    const record = (worldDraft.installedBundles ?? []).find((b) => b.installId === installId);
    if (!record) return false;
    const entryIds = new Set(record.entryIds);
    const variableIds = new Set(record.variableIds);
    const ruleIds = new Set(record.ruleIds);
    const reactionIds = new Set(record.reactionIds ?? []);
    const audioIds = new Set(record.audioTrackIds);
    const currentHash = hashString(
      projectBundleContent({
        entries: worldDraft.entries.filter(
          (e) => e.bundleInstallId === installId || entryIds.has(e.id),
        ),
        variables: worldDraft.variables.filter((v) => variableIds.has(v.id)),
        rules: worldDraft.rules.filter((r) => ruleIds.has(r.id)),
        reactions: (worldDraft.reactions ?? []).filter((r) => reactionIds.has(r.id)),
        audioTracks: (worldDraft.audioTracks ?? []).filter((t) => audioIds.has(t.id)),
        files: bundleFilesFor(record.slug, worldDraft.rootComponent?.files ?? {}),
      }),
    );
    return currentHash !== record.originalHash;
  },

  setGalleryImages: (images) => set((s) => guestProtectedUpdate(s, { galleryImages: images, isDirty: true })),
  setAnnouncement: (value) => set((s) => guestProtectedUpdate(s, { announcement: value, isDirty: true })),
  setApproxTime: (value) => set((s) => guestProtectedUpdate(s, { approxTime: value, isDirty: true })),
  setTags: (tags) => set((s) => guestProtectedUpdate(s, { tags, isDirty: true })),
  setLanguage: (value) => set((s) => guestProtectedUpdate(s, { language: value, isDirty: true })),
  setVariantLabel: (value) => set((s) => guestProtectedUpdate(s, { variantLabel: value, isDirty: true })),

  loadVariants: async () => {
    const { serverWorldId } = get();
    if (!serverWorldId) return;
    set({ variantsLoading: true });
    try {
      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}/language-variants`, {
        credentials: "include",
      });
      if (res.ok) {
        const { data } = await res.json();
        set({ variants: data ?? [], variantsLoading: false });
      } else {
        console.warn("[Editor] Failed to load variants:", res.status);
        set({ variantsLoading: false });
      }
    } catch (err) {
      console.warn("[Editor] Failed to load variants:", err);
      set({ variantsLoading: false });
    }
  },

  createVariant: async (label: string, language?: string | null) => {
    const { serverWorldId, isDirty } = get();
    if (!serverWorldId) return null;

    // Auto-save current world if dirty
    if (isDirty) {
      const saved = await get().saveDraft();
      if (!saved) return null;
    }

    try {
      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}/create-variant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ label, ...(language ? { language } : {}) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Create variant failed:", (err as { error?: string }).error);
        feedback.error(tr("editor:variantBar.createFailed", "Couldn't create the version"));
        return null;
      }
      const { data } = await res.json();
      // Update current world's languageGroupId if it was just assigned
      set({ languageGroupId: data.languageGroupId });
      // Reload variants list
      await get().loadVariants();
      return data.world.id as string;
    } catch {
      feedback.error(tr("editor:variantBar.createFailed", "Couldn't create the version"));
      return null;
    }
  },

  setPrimary: async (variantId: string) => {
    try {
      const res = await fetch(`${apiBase}/api/worlds/${variantId}/set-primary`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setPrimaryFailed(variantId);
        return;
      }
      // The 主 star moves in the variant bar — that is the confirmation.
      await get().loadVariants();
      useWorldsStore.getState().invalidate();
    } catch {
      setPrimaryFailed(variantId);
    }
  },

  saveDraft: () => serializeEditorSave(async () => {
    // Inspection/guest edits stay local. The wrapper serializes callers;
    // never save the previous draft while another world is still loading.
    if (get().readOnlyInspect || get().guestMode || get().saving || get().loadingWorld) return false;

    const started = get();
    const { worldDraft, serverWorldId, language, variantLabel } = started;
    const sessionAtSave = editorSession;
    const isCurrentSession = () => sessionAtSave === editorSession;
    const invalidVariable = invalidJsonDefault(worldDraft.variables);
    if (invalidVariable) {
      showWorldSaveError(i18n.t("editor:variables.jsonSaveBlocked", { name: invalidVariable.name }));
      return false;
    }
    const draftAtSave = worldDraft; // snapshot for race-condition check
    set({ saving: true });

    try {
      // Normalize positions before save — guarantees clean 0,1,2... per section
      const cleanEntries = normalizePositions(worldDraft.entries);
      const cleanDraft = { ...worldDraft, entries: cleanEntries };

      // Strip avatar from schema — the cover image is stored server-side
      // as thumbnailUrl (via the thumbnail upload endpoint), not in the
      // schema JSON. Saving presigned URLs here would cause expired-URL
      // issues on next load.
      const { avatar: _avatar, ...schemaWithoutAvatar } = cleanDraft;

      const payload: Record<string, unknown> = {
        name: cleanDraft.name || "Untitled World",
        description: cleanDraft.description,
        schema: schemaWithoutAvatar as unknown as Record<string, unknown>,
        language: language || null,
        variantLabel: variantLabel || null,
        // Preserve the last-synced version for the server's concurrency guard.
        baseUpdatedAt: get().baseUpdatedAt,
      };
      const errorOptions = { ...saveErrorOptions, payload };
      const validationError = worldSaveValidationMessage(payload, Boolean(serverWorldId), errorOptions);
      if (validationError) {
        showWorldSaveError(validationError);
        return false;
      }

      // Phase 3: stamp the rootComponent with pre-compiled JS so play-time can
      // skip the in-browser recompile. Cached per session by file hash; on
      // compile failure — or when the source carries inline data: URIs, which
      // the server's anti-bloat scanner would double-count and reject — we omit
      // `compiled` and play-time falls back to the live client compile. Never
      // blocks the save.
      const rootForCompile = schemaWithoutAvatar.rootComponent;
      if (rootForCompile && Object.keys(rootForCompile.files ?? {}).length > 0) {
        const rcEntry = rootForCompile.entryFile || "index.tsx";
        const rcFiles = rootForCompile.files;
        const hasInlineDataUri = /data:[a-z]+\//i.test(JSON.stringify(rcFiles));
        if (!hasInlineDataUri) {
          const filesHash = hashRootFiles(rcEntry, rcFiles);
          let code = rootCompileCache.get(filesHash);
          if (code === undefined) {
            try {
              const keys = Object.keys(rcFiles);
              if (keys.length <= 1) {
                const { transformTSX } = await import("@/features/studio/lib/tsx-compiler");
                code = transformTSX(rcFiles[rcEntry] ?? rcFiles[keys[0] ?? ""] ?? "").code || "";
              } else {
                const { bundleTSX } = await import("@/features/studio/lib/tsx-bundler");
                code = bundleTSX({ files: rcFiles, entryFile: rcEntry }).code || "";
              }
              if (code) rootCompileCache.set(filesHash, code);
            } catch {
              code = "";
            }
          }
          if (code) {
            schemaWithoutAvatar.rootComponent = {
              ...rootForCompile,
              compiled: { code, filesHash, compilerVersion: COMPILED_FORMAT_VERSION },
            };
          }
        }
      }

      // Precompiled JS is optional. If it doubles a large imported world past
      // the API body limit, save its complete source and compile on play instead.
      const saveBody = serializeWorldSavePayload(payload);
      if (!isCurrentSession()) return false;

      if (serverWorldId) {
        const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: saveBody,
        });
        if (!isCurrentSession()) {
          if (res.ok) useWorldsStore.getState().invalidate();
          return false;
        }
        if (res.ok) {
          useWorldsStore.getState().invalidate();
          // The server tells us whether a material change to this published
          // world was held back from the live card for re-review.
          const body = await res.json().catch(() => ({ data: {} }));
          const updated = (body as { data?: { pendingEdit?: WorldPendingEditSummary | null; heldForReview?: string[]; supersededReview?: boolean; updatedAt?: string } })?.data ?? {};
          if (!isCurrentSession() || !canApplyServerSnapshot(updated.updatedAt, started, get())) return false;
          dismissSaveError?.();
          localStorage.removeItem(DRAFT_KEY);
          const noDriftDuringSave = get().worldDraft === draftAtSave;
          // Advance the ancestor with the version this request saved, not any
          // edits made while it was in flight. Keep the client's representation:
          // server normalization remains a server-side change on the next merge,
          // and a published PATCH may return the old live schema, not the saved
          // working draft. A stale ancestor misclassifies already-saved UI files
          // as new local edits and lets them overwrite later agent changes.
          set({
            _baseSchema: structuredClone(draftAtSave),
            ...(noDriftDuringSave ? { isDirty: false } : {}),
          });
          // Re-sync the concurrency token to the just-written server updatedAt so
          // the next save isn't a false STALE_WORLD conflict. Unconditional: the
          // server row is now at updated.updatedAt regardless of whether the
          // local draft drifted (kept editing) during the save.
          const savedToken = validServerToken(updated.updatedAt);
          if (savedToken) {
            set({ baseUpdatedAt: savedToken });
          }
          if (updated.pendingEdit !== undefined) {
            set({ pendingEdit: updated.pendingEdit });
          }
          // No "Saved" message: the header's Save button reads lastSavedAt, and
          // the review side-effects show up in the review chip. `pendingEdit`
          // above flips it from blue "In review" to amber "Changes to submit"
          // when the save superseded a submission (supersededReview) or held
          // material changes back (heldForReview) — and its panel spells out
          // that they need submitting, which a 3-second toast never could.
          set({ lastSavedAt: Date.now() });
          // If Studio made changes while we had unsaved edits, refresh now that we've saved
          if (noDriftDuringSave && get()._pendingServerRefresh) {
            set({ _pendingServerRefresh: false });
            get().refreshWorldSchema().catch(() => {});
          }
          return true;
        } else if (res.status === 409) {
          // Locked while in review — say why the edits are not sticking.
          const body = await res.json().catch(() => ({}));
          if (!isCurrentSession()) return false;
          const code = (body as { code?: string })?.code;
          if (code === "WORLD_IN_REVIEW") {
            // The server just told us authoritatively that this card is in
            // review — sync the chip so it offers "withdraw" instead of a
            // misleading "Not live"/"Publish" state.
            set({ worldStatus: "pending_review" });
            feedback.error(tr("editor:review.lockedToast", "In review — withdraw it to edit"));
            return false;
          }
          if (code === "STALE_WORLD") {
            // The Studio agent (or another tab) changed this world after we
            // loaded it. Don't clobber its work AND don't discard the user's
            // edits — 3-way merge them against the last-synced ancestor
            // (_baseSchema). The merged result stays dirty; the next save (manual
            // or autosave) persists it with the fresh token.
            try {
              const sres = await fetch(`${apiBase}/api/worlds/${serverWorldId}?forEdit=1&_t=${Date.now()}`, {
                credentials: "include",
                cache: "no-store",
              });
              if (!sres.ok) throw new Error("could not fetch server draft");
              const { data: sdata } = await sres.json();
              if (!isCurrentSession() || !sdata || sdata.id !== serverWorldId || !canApplyServerSnapshot(sdata.updatedAt, started, get())) return false;
              const serverDraft = buildServerDraftFromData(sdata);
              const { merged, conflicts } = mergeWorldDefinition(get()._baseSchema, get().worldDraft, serverDraft);
              merged.entries = normalizeFolders(merged).world.entries;
              if (conflicts.length > 0) {
                // Both sides edited the same item(s): the merge kept the user's
                // version. Stash the server alternative so it stays recoverable.
                try {
                  localStorage.setItem(
                    `yumina-editor-conflict-${serverWorldId}`,
                    JSON.stringify({ serverDraft, conflicts, savedAt: Date.now() }),
                  );
                } catch { /* storage unavailable — best effort */ }
              }
              set({
                worldDraft: merged,
                _baseSchema: structuredClone(serverDraft),
                baseUpdatedAt: validServerToken(sdata.updatedAt) ?? get().baseUpdatedAt,
                isDirty: true,
                _past: [],
                _future: [],
                canUndo: false,
                canRedo: false,
              });
              // The save did NOT go through: say so, and say it stayed merged.
              feedback.error(
                conflicts.length > 0
                  ? tr("editor:save.mergedConflictsToast", "Merged — your version was kept")
                  : tr("editor:save.mergedToast", "Merged the assistant's changes — save again"),
              );
            } catch {
              if (!isCurrentSession()) return false;
              // Couldn't reach the server to merge (offline/transient). Keep the
              // user's edits as-is — never discard — and let them retry.
              feedback.error(tr("editor:save.staleWorldToast", "Couldn't save — try again in a moment"), {
                label: tr("common:action.retry", "Retry"),
                onClick: () => void useEditorStore.getState().saveDraft(),
              });
            }
            return false;
          }
          showWorldSaveError(worldSaveErrorMessage(res.status, body, errorOptions));
          return false;
        } else {
          const body = await res.json().catch(() => null);
          if (!isCurrentSession()) return false;
          showWorldSaveError(worldSaveErrorMessage(res.status, body, errorOptions));
          return false;
        }
      } else {
        const res = await fetch(`${apiBase}/api/worlds`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: saveBody,
        });
        if (!isCurrentSession()) {
          if (res.ok) useWorldsStore.getState().invalidate();
          return false;
        }
        if (res.ok) {
          const { data } = await res.json();
          if (!isCurrentSession()) {
            useWorldsStore.getState().invalidate();
            return false;
          }
          if (!canApplyServerSnapshot(data.updatedAt, started, get())) return false;
          dismissSaveError?.();
          // Only clear dirty if no changes were made during the save
          const updates: Partial<EditorState> = {
            serverWorldId: data.id,
            _baseSchema: structuredClone(draftAtSave),
          };
          const savedToken = validServerToken(data.updatedAt);
          if (savedToken) {
            updates.baseUpdatedAt = savedToken;
          }
          const noDriftDuringSave = get().worldDraft === draftAtSave;
          if (noDriftDuringSave) {
            updates.isDirty = false;
          }
          set(updates);
          localStorage.removeItem(DRAFT_KEY);
          useWorldsStore.getState().invalidate();
          set({ lastSavedAt: Date.now() });
          // A saved language change makes the server demote/reconcile 主/副; refresh
          // the variant bar so its stars match the server (no stale/duplicate 主).
          if (get().languageGroupId) get().loadVariants();
          // If Studio made changes while we had unsaved edits, refresh now that we've saved
          if (noDriftDuringSave && get()._pendingServerRefresh) {
            set({ _pendingServerRefresh: false });
            get().refreshWorldSchema().catch(() => {});
          }
          return true;
        } else {
          const body = await res.json().catch(() => null);
          if (!isCurrentSession()) return false;
          showWorldSaveError(worldSaveErrorMessage(res.status, body, errorOptions));
          return false;
        }
      }
    } catch (error) {
      if (!isCurrentSession()) return false;
      showWorldSaveError(worldSaveExceptionMessage(error, saveErrorOptions));
      return false;
    } finally {
      if (isCurrentSession()) set({ saving: false });
    }
  }),

  loadDraftFromStorage: () => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const { draft, serverId, savedAt } = parsed;
      // Discard drafts older than 7 days
      if (savedAt && Date.now() - savedAt > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      if (draft) {
        // Migrate draft if it's in an older schema format
        const migrated = migrateWorldDefinition(draft);
        migrated.entries = normalizePositions(migrated.entries);
        editorSession++;
        set({
          worldDraft: migrated,
          serverWorldId: serverId ?? null,
          saving: false,
          loadingWorld: false,
          isDirty: true,
          // Recovered local draft — token unknown; guard stays off until the
          // next save/refresh re-syncs it (avoids a false STALE_WORLD).
          baseUpdatedAt: null,
          _baseSchema: null,
          _past: [],
          _future: [],
          canUndo: false,
          canRedo: false,
          // Reset all DB-level / variant state to prevent leaks from previous world
          galleryImages: [],
          announcement: "",
          approxTime: "",
          tags: [],
          worldIsPublished: false,
          worldStatus: null,
          submittedForReviewAt: null,
          pendingEdit: null,
          language: null,
          languageGroupId: null,
          variantLabel: null,
          variants: [],
          variantsLoading: false,
        });
      }
    } catch {
      // ignore corrupted storage
    }
  },

  clearDraft: () => {
    retireRecoveryOffer();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    localStorage.removeItem(DRAFT_KEY);
    set({
      isDirty: false,
      galleryImages: [],
      announcement: "",
      approxTime: "",
      tags: [],
      worldIsPublished: false,
      worldStatus: null,
      submittedForReviewAt: null,
      pendingEdit: null,
      language: null,
      languageGroupId: null,
      variantLabel: null,      variants: [],
      variantsLoading: false,
    });
  },

  stopAutosave: () => {
    // Called from every editor route's unmount cleanup — leaving the editor
    // makes a recovery offer meaningless, and a persistent pill must not
    // linger over Discover.
    retireRecoveryOffer();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    if (newWorldSaveTimer) { clearTimeout(newWorldSaveTimer); newWorldSaveTimer = null; }
    stopServerAutosave();
  },
}));
