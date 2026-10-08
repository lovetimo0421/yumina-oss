import { invalidJsonDefault } from "@/features/editor/lib/json-default";
import { create } from "zustand";
import { feedback } from "@/lib/feedback";
import { captureHubEvent } from "@/lib/analytics";
import type {
  WorldDefinition,
  Variable,
  Rule,
  Reaction,
  GameComponent,
  AudioTrack,
  SceneImage,
  BackgroundImage,
  WorldEntry,
  EntryFolder,
  InstalledBundle,
  YuminaBundle,
  LoreUiBinding,
  Worldbook,
} from "@yumina/engine";
import { nextBundleColorKey } from "@/lib/entry-constants";
import { syncMessageRulesEntry, nextBackgroundId, COVER_BACKGROUND_URL, migrateWorldDefinition, deriveSectionDefaults, deriveSectionDefaultsForEntry, officialPresetsFor, customUIToRootFiles, normalizeFolders, mergeWorldDefinition, remapReactionReferences, applyGraphEdit, compileUiDoc, buildUiTheme, getUiTemplate, getUiPageTemplate, insertPageTemplate, fitTextBox, refreshConfirmSummary, carryOpeningChain, detectUiTemplate, withPreciseTrackingDefault, suggestedContinuityDelta, USER_ROOT_PATH, COMPOSED_MARKER, BUNDLE_NS_RE, generateComposedIndex, syncGreetingActions, PromptBuilder } from "@yumina/engine";
import { materializeBehaviors } from "@/features/editor/lib/editable-behaviors";
import type { OfficialPreset } from "@yumina/engine";
import { classifyInterface, startingUiDoc } from "@/features/studio/lib/ui-doc-takeover";
import type { WorldPendingEditSummary } from "@yumina/shared";
import type { WorldTemplate } from "@/lib/world-templates";
import i18n, { contentLanguage } from "@/lib/i18n";
import { clampLanguage } from "@/lib/language-clamp";
import { uploadAssetWithPresignedUrl } from "@/lib/asset-upload";
import { useWorldsStore } from "./worlds";
import { hashRootFiles, COMPILED_FORMAT_VERSION } from "@/features/studio/lib/compiled-format";
import { getVariableIdUsage } from "@/features/editor/lib/variable-id-references";
import { autoRenameFor, reconcileAutoVariables, uniqueVariableName } from "./ui-doc-auto-variables";
import { findTemplateLeftovers } from "@/features/studio/lib/template-leftovers";
import { serializeWorldSavePayload, worldSaveErrorMessage, worldSaveValidationMessage, worldSaveExceptionMessage, type WorldSaveErrorOptions } from "@/lib/world-save-payload";
import { EDITOR_DRAFT_KEY, writeStoredDraft } from "@/features/editor/editor-draft-recovery";
import { flushPendingEditorFields } from "@/features/editor/components/flush-pending-edits";

const apiBase = import.meta.env?.VITE_API_URL || "";

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

const DRAFT_KEY = EDITOR_DRAFT_KEY;

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
      const entry = sectionEntries[i]!;
      // Keep the object when its position already holds. Every delete and
      // duplicate runs through here, and a fresh clone of every entry defeats
      // the row memos and token caches keyed on entry identity.
      result.push(entry.position === i ? entry : { ...entry, position: i });
    }
  }
  // Same order, same objects → hand back the input so selectors see no change.
  return result.length === entries.length && result.every((entry, i) => entry === entries[i]) ? entries : result;
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
function nextCopyName(sourceName: string, entries: readonly { name: string }[], mark: string): string {
  // The canvas's word comes with the space it needs after a name (" 副本");
  // inside the brackets it read "好感度 ( 副本)".
  const suffix = mark.trim() || "copy";
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
// Snapshots share structure (every mutation spreads, never deep-clones), so a
// deep stack costs references, not copies. 20 was nothing on the canvas, where
// a burst of node adds burns the whole stack in seconds.
const MAX_HISTORY = 100;

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

/** The opening a card is born with. Its text is the world template's
 *  guidance, as a placeholder (`template-content:` tag), so a blank card asks
 *  the same question a templated one does: what does the player see first? */
function blankGreetingEntry(): WorldEntry {
  const defaults = deriveSectionDefaults("system-presets");
  return {
    id: crypto.randomUUID(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    name: (i18n as any).t("world.entries.greeting.name", { ns: "templates-content" }) as string,
    content: "",
    role: "greeting",
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    position: 0,
    section: "system-presets",
    ...defaults,
    alwaysSend: true,
    tags: ["template-content:world-greeting"],
  } as WorldEntry;
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

/** Bundle composition contract: see engine `bundles/composed-index.ts`. The
 *  composer is shared with the server's Studio tools so both sides write the
 *  same bytes. Re-exported here for existing importers. */
export { USER_ROOT_PATH, COMPOSED_MARKER, BUNDLE_NS_RE, generateComposedIndex };

/** Compile the document without replacing the entry that mounts installed UI
 * bundles. A card decomposed after installing bundles already has that composer
 * inside its preserved base; keep it there to avoid mounting each bundle twice. */
function compileEditorUiDoc(
  doc: NonNullable<WorldDefinition["uiDoc"]>,
  previous: WorldDefinition["rootComponent"],
): NonNullable<WorldDefinition["rootComponent"]> {
  const built = compileUiDoc(doc);
  const files = { ...(previous?.files ?? {}), ...built.files };
  const folders = Object.keys(files).flatMap((name) => {
    const match = name.match(BUNDLE_NS_RE);
    return match ? [match[1]!] : [];
  }).sort();
  const baseFile = doc.base?.file;
  const baseComposes = baseFile && previous?.files[baseFile]?.startsWith(COMPOSED_MARKER);
  if (baseComposes) {
    files[baseFile] = generateComposedIndex(folders);
  } else if (
    previous?.files["index.tsx"]?.startsWith(COMPOSED_MARKER) ||
    (folders.length > 0 && previous?.files[USER_ROOT_PATH] !== undefined)
  ) {
    // Also repairs cards previously saved with an overwritten composer: their
    // bundle files and user entry survived, but index.tsx stopped mounting them.
    files[USER_ROOT_PATH] = built.files[built.entryFile]!;
    files["index.tsx"] = generateComposedIndex(folders);
  }
  const unchanged = previous?.entryFile === built.entryFile &&
    Object.keys(previous.files).length === Object.keys(files).length &&
    Object.entries(files).every(([name, code]) => previous.files[name] === code);
  if (unchanged) return previous;
  const { compiled: _compiled, ...rest } = previous ?? {};
  return {
    ...rest,
    id: previous?.id || crypto.randomUUID(),
    name: previous?.name || "Interface",
    entryFile: built.entryFile,
    files,
    updatedAt: new Date().toISOString(),
    generatedFrom: "uiDoc",
  };
}

/** The interface the editor built from the card's document is not the one the
 *  server has: nothing was edited, but the compiler has changed since the last
 *  save (opening a card builds it again). Whatever runs or publishes the card
 *  saves first, or it would go out with the old build. */
export function generatedInterfaceUnsaved(s: Pick<EditorState, "worldDraft" | "_baseSchema">): boolean {
  const built = s.worldDraft.rootComponent;
  const saved = s._baseSchema?.rootComponent;
  if (!built || built.generatedFrom !== "uiDoc" || built === saved) return false;
  if (!saved || saved.entryFile !== built.entryFile) return true;
  const names = Object.keys(built.files);
  return names.length !== Object.keys(saved.files ?? {}).length || names.some((name) => saved.files[name] !== built.files[name]);
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
    galleryCoverCrop: undefined,
    // Every card begins with an opening, the blank one too: it is the first
    // thing a player reads and the first thing an author writes, and a card
    // without one opened on nothing. Empty on purpose — the guidance shows as
    // its placeholder, the same way a template's does.
    entries: [blankGreetingEntry(), ...officialPresetsFor(clampLanguage(i18n.language)).map(presetToEntry)],
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
  | "backgrounds"
  | "packs"
  | "first-message"
  | "entries"
  | "variables"
  | "rules"
  | "modules"
  | "components"
  | "apps"
  | "audio"
  | "scene-images"
  | "assets"
  | "generation"
  | "overview"
  | "bundles";

interface EditorState {
  worldDraft: WorldDefinition;
  serverWorldId: string | null;
  /** Creator of the card loadWorld fetched. A published card loads for anyone,
   *  so the editor routes compare this with the signed-in user before editing. */
  serverCreatorId: string | null;
  isDirty: boolean;
  /** Canvas positions changed and want persisting. Deliberately separate from
   *  `isDirty`: laying blocks out is a view action, and `isDirty` is what says
   *  "Unsaved" and puts a live card into "changes to submit". Save still
   *  flushes it. */
  layoutDirty: boolean;
  activeSection: EditorSection;
  saving: boolean;
  loadingWorld: boolean;
  /** Why the last loadWorld failed — the studio route renders a dead end
   *  instead of spinning forever. Null while loading or on success. */
  loadError: "notFound" | "failed" | null;

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

  /** Which module the lorebook / variables / behaviours pages are narrowed
   *  to: "all", "core" (the card's own, shared with every module), "bindings"
   *  (the lorebook's frontend-controlled view) or "mod:<id>". One value for
   *  the three pages, so the module page can hand it over when it jumps. */
  moduleScope: string;
  setModuleScope: (scope: string) => void;
  /** An object one page asked another to open. The receiving page selects it
   *  and clears this; a stale focus is never replayed. */
  pendingFocus: { kind: "entry" | "greeting" | "variable" | "reaction" | "module" | "audio" | "sceneImage"; id: string } | null;
  clearPendingFocus: () => void;
  /** Go to an object's own page, narrowed to its module, with it selected. */
  focusObject: (kind: "entry" | "greeting" | "variable" | "reaction" | "module" | "audio" | "sceneImage", id: string, worldbookId?: string) => void;

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
  /** Forget the undo history: what is on screen becomes the starting point.
   *  For a card just made from a template, starter or bundle, where the
   *  first undo would otherwise take the whole template away. */
  clearHistory: () => void;
  redo: () => void;

  // Actions
  /** A fresh card. `opening`, when given, is its first opening, written in
   *  as the card's starting state (not an edit: nothing to undo or save). */
  createNew: (opening?: { name: string; content: string; tags?: string[] }) => void;
  loadWorld: (worldId: string) => Promise<void>;
  /**
   * Pull current server truth into the editor. Studio calls this after an agent
   * run so the agent's changes appear. When the editor has unsaved edits it
   * 3-way merges (server + local) instead of bailing — that bail was the bug
   * where the agent's changes didn't show until a reload. (`force` is vestigial.)
   */
  refreshWorldSchema: (force?: boolean, options?: { source: "cover-upload"; target?: "portrait" | "landscape" }) => Promise<void>;
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
  setSettings: <K extends keyof NonNullable<WorldDefinition["settings"]>>(
    key: K,
    value: NonNullable<WorldDefinition["settings"]>[K]
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
  /** `worldbookId` files the new variable under that module — pass the scope
   *  being viewed, or a variable made while filtering to a module lands in
   *  the card's shared scope and drops out of the list it was made from. */
  addVariable: (worldbookId?: string) => void;
  duplicateVariable: (id: string, copySuffix?: string) => string | null;
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
  addSceneImage: () => void;
  updateSceneImage: (id: string, updates: Partial<SceneImage>) => void;
  removeSceneImage: (id: string) => void;
  /** Adds a background. With no url, the card's own cover fills it — the
   *  zero-asset path that makes this a one-click feature. Returns the id. */
  addBackground: (url?: string) => string;
  updateBackground: (id: string, updates: Partial<BackgroundImage>) => void;
  removeBackground: (id: string) => void;
  setBgmPlaylist: (playlist: import("@yumina/engine").BGMPlaylist | undefined) => void;
  updateBgmPlaylist: (updates: Partial<import("@yumina/engine").BGMPlaylist>) => void;
  /** Continuity judge switches (world-level). Missing = enabled, pools off. */
  updateContinuity: (updates: Partial<import("@yumina/engine").ContinuityConfig>) => void;
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

  // Blueprint canvas — layout persistence (not undo-tracked) + graph edits
  setGraphLayout: (layout: import("@yumina/engine").GraphLayout) => void;
  applyGraphPatch: (patch: import("@yumina/engine").GraphPatch) => void;

  // Interface document — the visual builder's single source of truth. Save-time
  // compiles it into rootComponent; the runtime never sees it.
  setUiDoc: (doc: import("@yumina/engine").UiDoc | undefined, opts?: { keepAutoVariables?: boolean }) => void;
  /**
   * A variable made FOR a part (a form question's answer, a popup's message):
   * a unique name, the given extras (an AI-facing rule), and a note that the
   * interface owns it — so deleting or re-binding the part removes it again
   * when nothing else reads it. See stores/ui-doc-auto-variables.ts.
   */
  makeAutoVariable: (
    name: string,
    type: Variable["type"],
    defaultValue: Variable["defaultValue"],
    extra?: Partial<Pick<Variable, "behaviorRules" | "description" | "aiAccess">> & { rule?: (name: string) => string },
  ) => { id: string; name: string };
  /** Keep an auto variable named after its part's question while the name is
   *  still the editor's own (see `autoRenameFor`). */
  syncAutoVariableName: (variableId: string, oldText: string, newText: string, fallback: string, rule?: (name: string) => string) => void;
  /** Made by makeAutoVariable, not yet bound by any doc. Not persisted. */
  pendingAutoVariables: string[];
  /** Start editing this card's interface visually. A hand-written frontend is
   *  preserved as the document's base layer; a template, when given, is the
   *  starting layout for cards with nothing to preserve. */
  adoptUiDoc: (template?: import("@yumina/engine").UiDoc) => void;
  /** The one-way exit: keep the generated code, drop the document, hand the
   *  card back to its creator to maintain by hand. */
  exportUiDocToCode: () => void;
  /** Pick an official look. A card with no interface of its own gets a document
   *  whose only content is the theme, over the platform's own chat. */
  applyUiTheme: (choice: import("@yumina/engine").UiThemeChoice | null) => void;
  /** Pick an official ARRANGEMENT. Creates the variables the layout is bound to
   *  if the card has none and puts on the layout's own colours; passing null
   *  puts the card back to the platform's chat, in the platform's look. */
  applyUiTemplate: (
    templateId: string | null,
    strings: import("@yumina/engine").UiTemplateStrings,
    /** One display name per `need.key` the layout declares. */
    variableNames: Record<string, string>,
    /** Starting values that only the caller's language knows — a time of day
     *  reads "清晨" or "Morning", never a value the engine could have held. */
    variableDefaults?: Record<string, string>,
  ) => void;
  /**
   * Add a ready-made FUNCTION as a new page — ask the player's name, pick an
   * opening, a title screen — spliced into the card's opening sequence, with
   * the variables it writes. A card with no interface of its own gets one
   * first (its current chat, or its hand-written frontend, stays underneath).
   * Returns the new page's id.
   */
  addPageTemplate: (
    templateId: string,
    words: {
      strings: Record<string, string>;
      /** Display name per variable id the template writes. */
      varNames: Record<string, string>;
      /** What the AI is told about each of them. */
      varRules: Record<string, string>;
      /** An opening with no name is called this. */
      openingTitle: (n: number) => string;
      /** The confirm page's words, to keep its summary in step. */
      confirmStrings?: Record<string, string>;
      /** Starting words for text variables (a time of day reads 「上午」 or
       *  "Morning" — only the creator's language knows). */
      varDefaults?: Record<string, string>;
    },
  ) => string | null;
  /** What the last layout switch left behind: variables the previous layout
   *  created, the new one does not bind, and nothing else references. Offered
   *  to the creator, never removed on their behalf. */
  templateLeftovers: { variableIds: string[]; names: string[] } | null;
  discardTemplateLeftovers: () => void;
  keepTemplateLeftovers: () => void;

  // Rule actions
  addRule: (variableId?: string) => void;
  updateRule: (id: string, updates: Partial<Rule>) => void;
  removeRule: (id: string) => void;
  reorderRules: (ruleIds: string[]) => void;

  // Reaction actions (event-driven rules)
  /** Same contract as addVariable's `worldbookId`. */
  addReaction: (worldbookId?: string) => void;
  duplicateReaction: (id: string, copySuffix?: string) => string | null;
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
  clearDraft: () => void;
  /** The creator chose "leave without saving": drop the unsaved edits for
   *  good — the crash-recovery copy included — so the next visit neither
   *  offers to recover them nor shows them from memory. The editor routes
   *  finish the job as they unmount (releaseDiscardedWorld). */
  discardUnsavedChanges: () => void;
  /** Called by the editor routes as they unmount: if this world's edits were
   *  discarded on the way out, forget the in-memory copy so the next open
   *  loads the saved card. */
  releaseDiscardedWorld: (worldId: string) => void;
  /** Stop the autosave timer without resetting editor state. Call on route unmount. */
  stopAutosave: () => void;
}

/** i18n from a store: no hook here, so read through the instance. */
const tr = (key: string, fallback: string, opts?: Record<string, unknown>) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, {
    defaultValue: fallback,
    ...opts,
  });

/**
 * Wait (briefly) for the editor's strings. They are a lazily loaded namespace,
 * and a pill's text is fixed when it is made — made before they arrive, it
 * reads the English fallback in any language. Never waits more than a moment:
 * a pill in English beats no pill.
 */
function editorStringsReady(): Promise<void> {
  if (i18n.hasLoadedNamespace?.("editor")) return Promise.resolve();
  const load = Promise.resolve()
    .then(() => i18n.loadNamespaces?.(["editor", "common"]))
    .then(() => undefined, () => undefined);
  return Promise.race([load, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
}

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
  // Updating one stable notification preserves its selectable details across
  // autosave failures. Never summarize away limits or corrective instructions.
  dismissSaveError = feedback.error(reason ?? tr("editor:save.failed", "Couldn't save your changes"), {
    label: tr("common:action.retry", "Retry"),
    onClick: () => void useEditorStore.getState().saveDraft(),
  }, { expanded: true, id: "world-save-error" });
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
  // A save error belongs to the editor session that produced it; its Retry
  // must not linger when a different world is opened.
  dismissSaveError?.();
  dismissSaveError = null;
  dismissRecoveryPill?.();
  dismissRecoveryPill = null;
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
/** True for the rest of the task in which stopAutosave ran: the editor is
 *  being left, so an edit committed by an unmounting field must not start
 *  timers again. See stopAutosave. */
let persistenceDetached = false;
/** Bumped each time the editor is left: a first save still in flight then
 *  must not start the server autosave for an editor nobody has open. */
let autosaveVisit = 0;
let serverAutosaveTimer: ReturnType<typeof setInterval> | null = null;
/** A STALE_WORLD save that merged cleanly retries itself once; this is the
 *  once. Module-level rather than store state: it is a re-entrancy guard for
 *  one call chain, not something the UI should ever read. */
let staleMergeRetryInFlight = false;
let loadAbort: AbortController | null = null;
// Distinguish editor visits, including A -> B -> A and two unsaved new cards.
// An old save must never update the draft loaded after its request started.
let editorSession = 0;
let activeSave: { session: number; promise: Promise<boolean> } | null = null;
/** The open document, and the one save allowed to write its result back. */
let editorDocumentEpoch = 0;
let activeSaveToken: symbol | null = null;

/** Which document is open. A field that commits after a delay (the debounced
 *  inputs) checks this so text typed into one card can never land in the
 *  card that replaced it. */
export function getEditorDocumentEpoch(): number {
  return editorDocumentEpoch;
}

/** Retire a previous document's save without waiting on its network request.
 * Its response and finally block must not touch the next document's state. */
function beginEditorDocument() {
  editorDocumentEpoch++;
  editorSession++;
  activeSaveToken = null;
}

function serializeEditorSave(save: () => Promise<boolean>): Promise<boolean> {
  const session = editorSession;
  // The STALE_WORLD path merges and then saves again from inside the save it
  // is still running. That retry must execute, not queue behind its own
  // promise — joining there is a deadlock, not serialization.
  if (staleMergeRetryInFlight) return save();
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
    if ((state.isDirty || state.layoutDirty) && !state.saving && state.serverWorldId) {
      // No confirmation: saveDraft stamps lastSavedAt and the header derives
      // its own "Saved" state from it. Autosave never mints a version.
      void state.saveDraft().then((ok) => {
        if (ok) captureHubEvent("studio_blueprint_saved", { world_id: state.serverWorldId!, trigger: "autosave" });
      });
    }
  }, SERVER_AUTOSAVE_INTERVAL);
}

function stopServerAutosave() {
  if (serverAutosaveTimer) { clearInterval(serverAutosaveTimer); serverAutosaveTimer = null; }
}

let newWorldSaveTimer: ReturnType<typeof setTimeout> | null = null;

let uiDocRecompileTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Recompile the uiDoc into rootComponent shortly after the visual editor goes
 * quiet, so the board's interface block previews what the creator is building
 * rather than what they last saved.
 *
 * A plain setState, deliberately outside commitDraft: the generated files are
 * derived state, and derived state in the undo history would make Ctrl+Z step
 * through compiler output. The save-time compile (Phase 3) stays the
 * authority — the compiler is deterministic, so this produces byte-identical
 * files and the save-time pass then finds nothing to change.
 */
/** What a card might already call the thing a page template tracks, in any
 *  UI language (lower-cased) — so the map moves the layout's own 「当前位置」. */
const SAME_THING: Record<string, string[]> = {
  location: ["所在地", "当前位置", "所在位置", "位置", "地点", "當前位置", "地點", "location", "current location", "place", "現在地", "場所", "ubicación", "lugar"],
  player_name: ["玩家名字", "玩家姓名", "主角名字", "主角名", "你的名字", "player name", "your name", "プレイヤー名", "主人公の名前", "nombre del jugador"],
  day: ["天数", "天數", "第几天", "day", "日数", "日目", "día"],
  health: ["生命", "生命值", "体力值", "hp", "health", "体力", "salud"],
  bag: ["背包", "行囊", "物品", "物品栏", "随身物品", "隨身物品", "物品欄", "inventory", "bag", "items", "持ち物", "所持品", "inventario", "mochila"],
  relations: ["人物关系", "关系", "羁绊", "人物關係", "relationships", "relations", "関係", "relaciones"],
};

/** Names an opening gets by default, in every UI language — not worth
 *  putting on a card the player picks from. */
const GENERIC_GREETING_NAME = /^(开场白|開場白|开场|開場|新建词条|新建詞條|greeting|opening|opening message|first message|new entry|挨拶|冒頭|オープニング|開幕メッセージ|新しいエントリ|saludo|inicio|mensaje de apertura|nueva entrada)\s*\d*$/i;

function scheduleUiDocRecompile() {
  if (uiDocRecompileTimer) clearTimeout(uiDocRecompileTimer);
  uiDocRecompileTimer = setTimeout(() => {
    uiDocRecompileTimer = null;
    useEditorStore.setState((s) => {
      const doc = s.worldDraft.uiDoc;
      const previous = s.worldDraft.rootComponent;
      // Only a generated frontend is ours to overwrite — same rule as save.
      if (!doc || previous?.generatedFrom !== "uiDoc") return {};
      try {
        const rootComponent = compileEditorUiDoc(doc, previous);
        if (rootComponent === previous) return {};
        return {
          worldDraft: {
            ...s.worldDraft,
            rootComponent,
          },
        };
      } catch {
        // A doc the compiler chokes on is the save path's problem to report;
        // the live preview just keeps showing the last good compile.
        return {};
      }
    });
  }, 600);
}

/**
 * Ordering for the recovery slot. Every scheduled write takes the next number;
 * a save that lands, and every document swap, retires the numbers issued up
 * to that point. The write is two hops away from its edit (a 2s debounce,
 * then an idle callback), so without this it could land AFTER the save that
 * already covered it had cleared the slot — and the next visit offered to
 * "recover" edits the server already had.
 */
/** The world whose unsaved edits the creator discarded on leaving; the
 *  route's unmount releases it (see releaseDiscardedWorld). */
let discardedWorldId: string | null = null;
let draftWriteSeq = 0;
let draftWritesRetiredThrough = 0;

/** Drop the stored draft and cancel every write issued so far. */
function clearStoredDraft(retireThrough = draftWriteSeq) {
  draftWritesRetiredThrough = Math.max(draftWritesRetiredThrough, retireThrough);
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** A save landed that covered every draft write issued before it started.
 *  Cancel those; clear the slot only when nothing was typed during the save —
 *  otherwise the slot may already hold those later edits, which the save did
 *  not include and a crash must still be able to recover. */
function settleStoredDraftAfterSave(seqAtSave: number, noDrift: boolean) {
  if (noDrift) clearStoredDraft(seqAtSave);
  else draftWritesRetiredThrough = Math.max(draftWritesRetiredThrough, seqAtSave);
}

function scheduleDraftSave(draft: WorldDefinition, serverId: string | null) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  const seq = ++draftWriteSeq;
  // The ancestor this draft was edited from, captured with it: a restore
  // merges against it instead of adopting whatever the server has by then.
  const { baseUpdatedAt, _baseSchema } = useEditorStore.getState();
  autosaveTimer = setTimeout(() => {
    // Skip write if a server save already cleared the dirty flag
    const draftState = useEditorStore.getState();
    if (!draftState.isDirty && !draftState.layoutDirty) return;
    if (seq <= draftWritesRetiredThrough) return;
    // Serialize off the main thread to avoid blocking UI (large worlds can be 3-10MB)
    const schedule = typeof requestIdleCallback === "function" ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 200);
    schedule(() => {
      // A save may have finished while this waited for idle time.
      if (seq <= draftWritesRetiredThrough) return;
      try {
        writeStoredDraft({ draft, serverId, savedAt: Date.now(), baseUpdatedAt, baseSchema: _baseSchema ?? undefined }, localStorage);
      } catch {
        // No storage at all (blocked site data, a torn-down page)
      }
    });
  }, AUTOSAVE_DELAY);

  if (!serverId) scheduleNewWorldSave();
}

/** For new worlds (no serverWorldId): auto-save to server after 5s of edits
 *  so Studio and Play become available without manual save. */
function scheduleNewWorldSave() {
  if (newWorldSaveTimer) clearTimeout(newWorldSaveTimer);
  newWorldSaveTimer = setTimeout(() => {
    newWorldSaveTimer = null;
    const state = useEditorStore.getState();
    if (!state.serverWorldId && state.isDirty && !state.saving && state.worldDraft.name) {
      const visit = autosaveVisit;
      state.saveDraft().then((ok) => {
        if (ok && visit === autosaveVisit) startServerAutosave();
      });
    }
  }, 5000);
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
/**
 * An interface step that starts from an opening names it; the chat counts
 * openings by position. When openings are added, removed or reordered (or the
 * interface changes), recount those steps so 「雨夜」 still starts 「雨夜」.
 */
function withOpeningStepsRecounted(prev: WorldDefinition, next: WorldDefinition): WorldDefinition {
  const doc = next.uiDoc;
  if (!doc || (prev.entries === next.entries && prev.uiDoc === doc)) return next;
  const ids = new PromptBuilder().buildGreetingEntries(next).map((e) => e.id);
  const synced = syncGreetingActions(doc, ids);
  if (synced === doc) return next;
  scheduleUiDocRecompile();
  return { ...next, uiDoc: synced };
}

function commitDraft(
  s: EditorState,
  newDraft: WorldDefinition
): Partial<EditorState> {
  // Every worldDraft mutation funnels through here — heal duplicate variable
  // ids no matter which path introduced them (manual edit, AI actions, import).
  newDraft = withNormalizedVariableIds(newDraft);
  newDraft = withOpeningStepsRecounted(s.worldDraft, newDraft);
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
  scheduleEditPersistence(s, newDraft);
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

interface RecoveredDraft {
  draft: WorldDefinition;
  /** The server version the draft was edited from; null for drafts written
   *  before the recovery slot recorded it. */
  baseUpdatedAt: string | null;
  /** That version's schema, when it fit in storage alongside the draft. */
  baseSchema: WorldDefinition | null;
}

function parseRecoveredDraft(parsed: { draft: unknown; baseUpdatedAt?: unknown; baseSchema?: unknown }): RecoveredDraft {
  const draft = migrateWorldDefinition(parsed.draft as WorldDefinition);
  draft.entries = normalizePositions(draft.entries);
  let baseSchema: WorldDefinition | null = null;
  if (parsed.baseSchema && typeof parsed.baseSchema === "object") {
    baseSchema = migrateWorldDefinition(parsed.baseSchema as WorldDefinition);
    baseSchema.entries = normalizePositions(baseSchema.entries);
  }
  return { draft, baseUpdatedAt: validServerToken(parsed.baseUpdatedAt), baseSchema };
}

/**
 * Decide what a restored draft becomes against the world as it loads now.
 *
 * Restoring used to replace the loaded draft outright while keeping the
 * freshly loaded concurrency token — so the save that followed looked
 * current, never met STALE_WORLD, and wrote over anything the assistant or
 * another device had saved since the draft was made. The draft now carries
 * its own base, and:
 *
 *  - same base as the server → nothing moved; the draft is simply newer.
 *  - different base, base schema kept → the same 3-way merge a STALE_WORLD
 *    save runs, with the draft's base as the ancestor.
 *  - different or unknown base, no schema → no ancestor to merge against.
 *    The draft wins (that is what the creator clicked for), and the server
 *    copy is stashed in the same slot STALE_WORLD conflicts use so it stays
 *    recoverable instead of vanishing on the next save.
 */
export function resolveRecoveredDraft(
  recovered: RecoveredDraft,
  server: { baseUpdatedAt: string | null; schema: WorldDefinition },
): { draft: WorldDefinition; conflicts: number; serverKeptAside: boolean } {
  const sameBase = recovered.baseUpdatedAt !== null && server.baseUpdatedAt !== null &&
    Date.parse(recovered.baseUpdatedAt) === Date.parse(server.baseUpdatedAt);
  if (sameBase) return { draft: recovered.draft, conflicts: 0, serverKeptAside: false };
  if (recovered.baseSchema) {
    const { merged, conflicts } = mergeWorldDefinition(recovered.baseSchema, recovered.draft, server.schema);
    merged.entries = normalizeFolders(merged).world.entries;
    return { draft: merged, conflicts: conflicts.length, serverKeptAside: conflicts.length > 0 };
  }
  return { draft: recovered.draft, conflicts: 0, serverKeptAside: true };
}

function restoreRecoveredDraft(recovered: RecoveredDraft) {
  const s = useEditorStore.getState();
  const serverSchema = s._baseSchema ?? s.worldDraft;
  const result = resolveRecoveredDraft(recovered, { baseUpdatedAt: s.baseUpdatedAt, schema: serverSchema });
  if (result.serverKeptAside && s.serverWorldId) {
    try {
      localStorage.setItem(
        `yumina-editor-conflict-${s.serverWorldId}`,
        JSON.stringify({ serverDraft: serverSchema, conflicts: result.conflicts, savedAt: Date.now() }),
      );
    } catch { /* storage unavailable — best effort */ }
  }
  useEditorStore.setState(commitDraft(s, result.draft));
  if (result.serverKeptAside) {
    feedback.notice(tr(
      "editor:shell.recoverDraftMerged",
      "This card changed elsewhere since then — your recovered version was kept",
    ));
  }
}

/**
 * The persistence half of commitDraft: the local recovery write and the
 * server autosave that an edit arms. Edits that do not go through
 * commitDraft — the metadata setters, an import — used to set isDirty and
 * nothing else, so the 60s autosave never started. Worse, the next real edit
 * then saw isDirty already true and skipped starting it too.
 *
 * `localDraft: false` is for metadata (tags, gallery, language…): the
 * recovery slot only holds worldDraft, so rewriting it would store nothing
 * new and still leave a "recover?" offer behind.
 */
function scheduleEditPersistence(
  s: Pick<EditorState, "guestMode" | "readOnlyInspect" | "isDirty" | "serverWorldId">,
  draft: WorldDefinition,
  { localDraft = true }: { localDraft?: boolean } = {},
) {
  if (s.guestMode || s.readOnlyInspect || persistenceDetached) return;
  if (localDraft) scheduleDraftSave(draft, s.serverWorldId);
  else if (!s.serverWorldId) scheduleNewWorldSave();
  // First edit on a saved world → kick off the periodic server autosave.
  // For new worlds (no serverWorldId yet), the new-world save handles the
  // initial save itself and starts the timer on success.
  if (!s.isDirty && s.serverWorldId) startServerAutosave();
}

/** A metadata setter's update: dirty, and persisted like any other edit. */
function metadataUpdate(s: EditorState, update: Partial<EditorState>): Partial<EditorState> {
  if (s.guestMode) return {};
  scheduleEditPersistence(s, s.worldDraft, { localDraft: false });
  return { ...update, isDirty: true };
}

/**
 * Build the editor's WorldDefinition draft from a server world payload.
 *
 * Single source of truth for the load transform used by the STALE_WORLD 3-way
 * merge, so the server side it fetches is shaped identically to the worldDraft /
 * _baseSchema the editor already holds (the merge's common-ancestor invariant).
 * loadWorld, refreshWorldSchema and loadWorldFromData all build through it.
 */
function buildServerDraftFromData(data: any): WorldDefinition {
  const schema = (data.schema ?? {}) as WorldDefinition;
  const rawSchema = data.schema as Record<string, unknown> | undefined;
  // Everything in the schema blob rides through by default. A field list that
  // names what to KEEP forgets whatever is added after it — tag colours,
  // installed packs, the narrator voice all went that way — and the next save
  // writes the loss back to the server. The lines below only fill defaults and
  // take the values the DB row owns.
  const rawDraft: WorldDefinition = {
    ...schema,
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
    entries: schema.entries || [],
    variables: normalizeVariableIds(schema.variables || []),
    rules: schema.rules || [],
    reactions: schema.reactions || [],
    components: schema.components || [],
    audioTracks: schema.audioTracks || [],
    customUI: schema.customUI || [],
    customTags: schema.customTags || [],
    loreUiBindings: normalizeLoreUiBindings(schema.loreUiBindings),
    worldbooks: schema.worldbooks ?? [],
    settings: {
      ...(rawSchema?.settings as WorldDefinition["settings"] | undefined),
      maxTokens: schema.settings?.maxTokens ?? 12000,
      maxContext: schema.settings?.maxContext ?? 200000,
      temperature: schema.settings?.temperature ?? 1.0,
      topP: schema.settings?.topP ?? 1,
      frequencyPenalty: schema.settings?.frequencyPenalty ?? 0,
      presencePenalty: schema.settings?.presencePenalty ?? 0,
      playerName: schema.settings?.playerName ?? "User",
      lorebookScanDepth: schema.settings?.lorebookScanDepth ?? 2,
      lorebookRecursionDepth: schema.settings?.lorebookRecursionDepth ?? 0,
    },
  } as WorldDefinition;
  const draft = migrateWorldDefinition(rawDraft);
  draft.entries = normalizePositions(draft.entries);
  // Heal dangling entry→folder refs so orphaned entries render (don't vanish).
  draft.entries = normalizeFolders(draft).world.entries;
  draft.loreUiBindings = normalizeLoreUiBindings(draft.loreUiBindings);
  return draft;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  worldDraft: createEmptyWorld(),
  serverWorldId: null,
  serverCreatorId: null,
  isDirty: false,
  layoutDirty: false,
  templateLeftovers: null,
  pendingAutoVariables: [],
  activeSection: "entries",
  saving: false,
  loadingWorld: false,
  loadError: null,
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
      // Batch complete — push the start snapshot as a single undo entry.
      // A batch that changed nothing (a paste that all failed, a press with
      // no drag) leaves no step: Ctrl+Z would otherwise appear to do nothing.
      if (s._batchStartDraft && s._batchStartDraft !== s.worldDraft) {
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

  clearHistory: () => set({ _past: [], _future: [], canUndo: false, canRedo: false }),

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
    // A snapshot's compiled frontend can predate its own uiDoc (edits closer
    // together than the recompile debounce), so stepping onto it redraws the
    // card from the doc rather than showing a stale compile.
    if (get().worldDraft.uiDoc) scheduleUiDocRecompile();
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
    // A snapshot's compiled frontend can predate its own uiDoc (edits closer
    // together than the recompile debounce), so stepping onto it redraws the
    // card from the doc rather than showing a stale compile.
    if (get().worldDraft.uiDoc) scheduleUiDocRecompile();
  },

  createNew: (opening) => {
    beginEditorDocument();
    retireRecoveryOffer();
    loadAbort?.abort();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    stopServerAutosave();
    const draft = createEmptyWorld();
    set({
      worldDraft: draft,
      serverWorldId: null,
      serverCreatorId: null,
      saving: false,
      loadingWorld: false,
      isDirty: false,
      layoutDirty: false,
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
    if (opening) {
      // The empty world already has its one (empty) opening: fill that.
      if (!get().worldDraft.entries.some((entry) => entry.role === "greeting")) get().addEntry("greeting", "system-presets");
      const first = get().worldDraft.entries.find((entry) => entry.role === "greeting");
      if (first) get().updateEntry(first.id, opening);
      set({ isDirty: false, _past: [], _future: [], canUndo: false, canRedo: false });
    }
    clearStoredDraft();
  },

  loadWorld: async (worldId: string) => {
    beginEditorDocument();
    retireRecoveryOffer();
    loadAbort?.abort();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    const controller = new AbortController();
    loadAbort = controller;
    set({ loadingWorld: true, serverWorldId: null, serverCreatorId: null, loadError: null, saving: false });

    // Check for a crash-recovery draft BEFORE clearing localStorage
    let recoveryDraft: RecoveredDraft | null = null;
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
          recoveryDraft = parseRecoveredDraft(parsed);
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
        // The route gates on serverWorldId, so a silent failure here reads as
        // an endless spinner. Record why so it can render a real dead end;
        // loadWorldFailed also offers the local recovery draft when one exists.
        loadWorldFailed(worldId);
        set({ loadingWorld: false, loadError: res.status === 403 || res.status === 404 ? "notFound" : "failed" });
        return;
      }
      const { data } = await res.json();
      if (controller.signal.aborted) return;
      const draft = buildServerDraftFromData(data);
      if (controller.signal.aborted) return;

      set({
        worldDraft: draft,
        serverWorldId: data.id,
        serverCreatorId: typeof data.creatorId === "string" ? data.creatorId : null,
        isDirty: false,
        layoutDirty: false,
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
      // The saved interface was built by the compiler of its last save. Build
      // it again so the board shows what the card's document makes today; a
      // run or a publish saves the new build (see generatedInterfaceUnsaved).
      if (draft.uiDoc) scheduleUiDocRecompile();

      // Clear localStorage draft only after successful load
      clearStoredDraft();

      // Offer crash recovery if we found a matching unsaved draft. It stays
      // until acted on (dropping it silently would lose the recovered work),
      // but it belongs to THIS world: the handle is retired by every world
      // swap, and the click re-checks the loaded id in case one slips through.
      //
      // The pill's text is fixed when it is made, and the editor's strings are
      // a lazily loaded namespace: made on a fresh page load, before any
      // editor component asked for them, it read the English fallback in a
      // Chinese editor. So it waits for them — and for nothing else to have
      // replaced this document meanwhile.
      if (recoveryDraft) {
        const recovered = recoveryDraft;
        const epoch = editorDocumentEpoch;
        await editorStringsReady();
        if (epoch === editorDocumentEpoch && get().serverWorldId === worldId) {
          retireRecoveryOffer();
          dismissRecoveryPill = feedback.persistent(
            tr("editor:shell.recoverDraftFound", "Unsaved changes from last time"),
            {
              label: tr("editor:shell.recoverDraftAction", "Recover"),
              onClick: () => {
                dismissRecoveryPill = null;
                if (get().serverWorldId !== worldId) return;
                restoreRecoveredDraft(recovered);
              },
            },
            { id: "editor-draft-recovery" },
          );
        }
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
      set({ loadingWorld: false, loadError: "failed" });
    }
  },

  refreshWorldSchema: async (_force = false, options) => {
    const afterCoverUpload = options?.source === "cover-upload";
    const syncFailed = () => new Error(tr("editor:save.coverRefreshFailed", "Cover uploaded, but the editor could not refresh. Reopen the world before adjusting the crop."));
    const started = get();
    const { serverWorldId } = started;
    const sessionAtRequest = editorSession;
    if (!serverWorldId) {
      if (afterCoverUpload) throw syncFailed();
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}?forEdit=1&_t=${Date.now()}`, {
        credentials: "include",
        cache: "no-store",
        ...(afterCoverUpload ? { signal: AbortSignal.timeout(20_000) } : {}),
      });
      if (!res.ok) throw syncFailed();
      const { data } = await res.json();
      if (sessionAtRequest !== editorSession || !data || data.id !== get().serverWorldId) throw syncFailed();
      if (!canApplyServerSnapshot(data.updatedAt, started, get())) throw syncFailed();
      if (afterCoverUpload && !validServerToken(data.updatedAt)) throw syncFailed();
      const draft = buildServerDraftFromData(data);
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
        if (afterCoverUpload) {
          // Uploads commit artwork separately. Keep the latest server image
          // paired with its crop, even if another tab replaced this upload.
          // The old image's unsaved crop must not survive onto the new image.
          if (options?.target === "landscape") {
            merged.landscapeCover = draft.landscapeCover;
            merged.landscapeCoverCrop = draft.landscapeCoverCrop;
          } else {
            merged.avatar = draft.avatar;
            merged.coverCrop = draft.coverCrop;
            merged.galleryCoverCrop = draft.galleryCoverCrop;
          }
        }
        // Layout (including authored notes) is editor-owned and is not one of
        // the engine merger's content fields. Keep its pending local write.
        if (get().layoutDirty) merged.graphLayout = get().worldDraft.graphLayout;
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
        if (!afterCoverUpload || conflicts.length > 0) feedback.notice(
          conflicts.length > 0
            ? tr("editor:save.agentMergedConflictsNotice", "Merged — your version kept")
            : tr("editor:save.agentMergedNotice", "Merged with agent changes"),
        );
        return;
      }

      // Content is clean, but an unsaved arrangement or note still belongs to
      // the creator. Adopt server content without losing that separate write.
      const layoutDirty = get().layoutDirty;
      set({
        worldDraft: layoutDirty ? { ...draft, graphLayout: get().worldDraft.graphLayout } : draft,
        isDirty: false,
        layoutDirty,
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
      if (draft.uiDoc) scheduleUiDocRecompile();
    } catch {
      // Crop saving depends on this fresh baseline. Unlike a background
      // refresh, a failed upload sync must not silently use the old revision.
      if (afterCoverUpload) throw syncFailed();
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
    beginEditorDocument();
    retireRecoveryOffer();
    loadAbort?.abort();
    const draft = buildServerDraftFromData(data);

    set({
      worldDraft: draft,
      serverWorldId: data.id,
      serverCreatorId: null,
      saving: false,
      isDirty: false,
      layoutDirty: false,
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
    if (draft.uiDoc) scheduleUiDocRecompile();
  },

  setActiveSection: (section) => set({ activeSection: section }),

  customUiTab: "code",
  setCustomUiTab: (tab) => set({ customUiTab: tab }),

  moduleScope: "all",
  setModuleScope: (scope) => set({ moduleScope: scope }),
  pendingFocus: null,
  clearPendingFocus: () => set({ pendingFocus: null }),
  focusObject: (kind, id, worldbookId) => {
    const section: EditorSection =
      kind === "entry" ? "entries" : kind === "greeting" ? "first-message" : kind === "variable" ? "variables" : kind === "reaction" ? "rules" : kind === "audio" ? "audio" : kind === "sceneImage" ? "scene-images" : "modules";
    set({
      activeSection: section,
      pendingFocus: { kind, id },
      // A module's own object opens its page narrowed to that module; the
      // card's own opens it narrowed to what every module shares.
      ...(kind === "module" || kind === "audio" || kind === "sceneImage" ? {} : { moduleScope: worldbookId ? `mod:${worldbookId}` : "core" }),
    });
  },

  setField: (key, value) => {
    set((s) => {
      const draft = { ...s.worldDraft, [key]: value };
      // Switching simple <-> advanced is a preference, not content: it must
      // not dirty the draft or trigger the new-world auto-save. On a
      // never-saved card that auto-save created a server draft the moment a
      // newcomer peeked at the other mode (leaving "Character Chat" x N in
      // their library). The mode still rides along on the next real save.
      if (key === "editorMode") {
        return { worldDraft: draft };
      }
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
        name: i18n.t("editor:entries.newEntry", { defaultValue: "New Entry" }),
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
        // Orphaned members fall back to the always-on Core (a module holds
        // entries + variables + behaviors — never leave dangling worldbookIds
        // that would fail-open silently).
        entries: s.worldDraft.entries.map((e) =>
          e.worldbookId === id ? { ...e, worldbookId: undefined } : e,
        ),
        variables: s.worldDraft.variables.map((v) =>
          v.worldbookId === id ? { ...v, worldbookId: undefined } : v,
        ),
        reactions: (s.worldDraft.reactions ?? []).map((r) =>
          r.worldbookId === id ? { ...r, worldbookId: undefined } : r,
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

  addVariable: (worldbookId) => {
    set((s) => {
      // New variables track precisely by default (owner decision): the
      // judge moves them after each reply rather than hoping the narrator
      // remembers a directive. Saved variables are never touched.
      const newVar: Variable = withPreciseTrackingDefault({
        id: crypto.randomUUID(),
        name: "New Variable",
        type: "number",
        defaultValue: 0,
        description: "",
        ...(worldbookId ? { worldbookId } : {}),
      });
      const draft = {
        ...s.worldDraft,
        variables: [...s.worldDraft.variables, newVar],
      };
      return commitDraft(s, draft);
    });
  },

  duplicateVariable: (id, copySuffix = "copy") => {
    const source = get().worldDraft.variables.find(variable => variable.id === id);
    if (!source || get().guestMode || get().readOnlyInspect) return null;
    const newId = crypto.randomUUID();
    set(s => {
      const index = s.worldDraft.variables.findIndex(variable => variable.id === id);
      if (index < 0) return s;
      const src = s.worldDraft.variables[index]!;
      const copy = { ...structuredClone(src), id: newId, name: nextCopyName(src.name, s.worldDraft.variables, copySuffix) };
      const variables = [...s.worldDraft.variables];
      variables.splice(index + 1, 0, copy);
      return commitDraft(s, { ...s.worldDraft, variables });
    });
    return newId;
  },

  updateVariableAt: (index, updates) => {
    set((s) => {
      const current = s.worldDraft.variables[index];
      if (!current) return {};
      const next = { ...current, ...updates };
      // A precise number still on its suggested per-turn window follows its
      // range: a fresh variable given 0–100 moves by up to 15, not the 10 it
      // was handed before it had a range. A window the creator typed stays.
      if (
        (updates.min !== undefined || updates.max !== undefined) &&
        updates.deltaDown === undefined && updates.deltaUp === undefined &&
        current.precise === true && current.type === "number"
      ) {
        const before = suggestedContinuityDelta(current);
        if (current.deltaDown === before && current.deltaUp === before) {
          const after = suggestedContinuityDelta(next);
          next.deltaDown = after;
          next.deltaUp = after;
        }
      }
      if (updates.id !== undefined) {
        const trimmed = updates.id.trim();
        if (!trimmed) {
          // An empty id would break every {{id}} reference — keep the old one.
          next.id = current.id;
        } else if (trimmed !== current.id && getVariableIdUsage(s.worldDraft, current).references.length > 0) {
          // Reject only the rename: other fields in this update still save.
          next.id = current.id;
          feedback.error(i18n.t("editor:variables.editing.idInUse", { defaultValue: "This ID is in use. Resolve its references before changing it; the display name can still be edited." }));
        } else {
          const taken = new Set(
            s.worldDraft.variables.filter((_, i) => i !== index).map((v) => v.id)
          );
          next.id = dedupeVariableId(trimmed, taken);
        }
      }
      if (Object.keys(updates).every((key) => Object.is(next[key as keyof Variable], current[key as keyof Variable]))) return {};
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
    const newVar: Variable = withPreciseTrackingDefault({
      id: crypto.randomUUID(),
      name: trimmed,
      type,
      defaultValue,
      description: "",
      ...(internal ? { internal: true } : {}),
    });
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
      const draft: WorldDefinition = {
        ...s.worldDraft,
        audioTracks: (s.worldDraft.audioTracks ?? []).filter(
          (t) => t.id !== id
        ),
      };
      // The playlist and the conditional-BGM rules point at tracks by id. Left
      // alone they keep pointing at a track that no longer exists: the
      // playlist tries to play it, and the rule's picker shows a blank choice
      // that still fires. A rule keeps its trigger — only its target is
      // cleared, so the creator can point it somewhere else.
      const playlist = s.worldDraft.bgmPlaylist;
      if (playlist?.tracks?.includes(id)) {
        draft.bgmPlaylist = { ...playlist, tracks: playlist.tracks.filter((t) => t !== id) };
      }
      const rules = s.worldDraft.conditionalBGM;
      if (rules?.some((r) => r.targetTrackId === id || r.fallback === id)) {
        draft.conditionalBGM = rules.map((r) =>
          r.targetTrackId === id || r.fallback === id
            ? {
                ...r,
                ...(r.targetTrackId === id ? { targetTrackId: "" } : {}),
                ...(r.fallback === id ? { fallback: "default" } : {}),
              }
            : r,
        );
      }
      return commitDraft(s, draft);
    });
  },

  addSceneImage: () => {
    set((s) => {
      const existing = s.worldDraft.sceneImages ?? [];
      // Short, stable handles (`img3`) — this is the token the AI has to
      // reproduce verbatim, so no UUIDs. Skip any number already taken.
      const used = new Set(existing.map((img) => img.id));
      let n = existing.length + 1;
      while (used.has(`img${n}`)) n++;
      const newImage: SceneImage = { id: `img${n}`, name: "", url: "", scene: "" };
      const draft = { ...s.worldDraft, sceneImages: [...existing, newImage] };
      return commitDraft(s, draft);
    });
  },

  updateSceneImage: (id, updates) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        sceneImages: (s.worldDraft.sceneImages ?? []).map((img) => {
          if (img.id !== id) return img;
          const next: Record<string, unknown> = { ...img, ...updates };
          // An explicit `undefined` clears an optional field (scope back to
          // "every opening", AI control back to default) instead of persisting
          // a literal undefined that the schema would reject on reload.
          for (const key of Object.keys(updates)) {
            if ((updates as Record<string, unknown>)[key] === undefined) delete next[key];
          }
          return next as unknown as SceneImage;
        }),
      };
      return commitDraft(s, draft);
    });
  },

  removeSceneImage: (id) => {
    set((s) => {
      const draft = {
        ...s.worldDraft,
        sceneImages: (s.worldDraft.sceneImages ?? []).filter((img) => img.id !== id),
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

  addBackground: (url) => {
    const existing = get().worldDraft.backgrounds ?? [];
    const id = nextBackgroundId(existing);
    set((s) => {
      const list = s.worldDraft.backgrounds ?? [];
      const created: BackgroundImage = {
        id,
        name: "",
        url: url ?? COVER_BACKGROUND_URL,
        // The first background is what the card shows; without this the author
        // adds a picture and nothing happens until they find the flag.
        ...(list.some((b) => b.isDefault) ? {} : { isDefault: true }),
      };
      return commitDraft(s, { ...s.worldDraft, backgrounds: [...list, created] });
    });
    return id;
  },

  updateBackground: (id, updates) => {
    set((s) => {
      // Exactly one default. Promoting one demotes the rest here rather than
      // leaving the resolver to break the tie by document order.
      const promoting = updates.isDefault === true;
      const backgrounds = (s.worldDraft.backgrounds ?? []).map((bg) => {
        if (bg.id !== id) return promoting && bg.isDefault ? { ...bg, isDefault: false } : bg;
        const next: Record<string, unknown> = { ...bg, ...updates };
        // An explicit `undefined` clears an optional field instead of
        // persisting a literal undefined the schema would reject on reload.
        for (const key of Object.keys(updates)) {
          if ((updates as Record<string, unknown>)[key] === undefined) delete next[key];
        }
        return next as unknown as BackgroundImage;
      });
      return commitDraft(s, { ...s.worldDraft, backgrounds });
    });
  },

  removeBackground: (id) => {
    set((s) => {
      const left = (s.worldDraft.backgrounds ?? []).filter((bg) => bg.id !== id);
      // Deleting the default hands the flag on, so the card keeps a background
      // instead of silently going blank.
      if (left.length > 0 && !left.some((bg) => bg.isDefault)) left[0] = { ...left[0], isDefault: true };
      return commitDraft(s, { ...s.worldDraft, backgrounds: left });
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

  updateContinuity: (updates) => {
    set((s) => {
      const merged = { ...(s.worldDraft.continuity ?? {}), ...updates };
      // Drop undefined keys so a world that never touched the feature stays
      // byte-identical (no `continuity: {}` in its export).
      const next = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
      const draft = { ...s.worldDraft, continuity: Object.keys(next).length > 0 ? next : undefined };
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

  setGraphLayout: (layout) =>
    set((s) => {
      const newDraft = { ...s.worldDraft, graphLayout: layout };
      // Persist node positions (crash-recovery + server autosave) without adding
      // to undo history — dragging nodes should not pollute the undo stack.
      //
      // And without `isDirty`, which is the PUBLISH-facing flag: it lights
      // "Unsaved", enables Save, and drives "changes to submit" on a live card.
      // Tidying the canvas — collapsing a block, tapping Formation, nudging a
      // node — is a view action, and a creator who only looked around should
      // not come back to a card that says it has changes waiting for review.
      // `layoutDirty` still carries the write.
      if (s.readOnlyInspect || s.guestMode) return { worldDraft: newDraft };
      // A board unmounting as the editor closes may still write its layout:
      // keep it in the draft, but do not start timers for an editor that left.
      if (persistenceDetached) return { worldDraft: newDraft, layoutDirty: true };
      scheduleDraftSave(newDraft, s.serverWorldId);
      if (!s.isDirty && s.serverWorldId) startServerAutosave();
      return { worldDraft: newDraft, layoutDirty: true };
    }),

  setUiDoc: (incoming, opts) => {
    set((s) => {
      // Variables the editor made for parts follow their parts: adopted when
      // a part binds one, removed (in this same commit, so one undo restores
      // both) when the last part that bound it lets go and nothing else reads
      // it. A cut keeps them — the part is on its way back.
      const reconciled = reconcileAutoVariables({
        world: s.worldDraft, nextDoc: incoming, pending: s.pendingAutoVariables, keep: opts?.keepAutoVariables,
      });
      const doc = reconciled.doc;
      // 特殊写法 rules are also instructions: the 「界面约定」 entry follows
      // them in the same commit, so an undo takes both back together. Same
      // array back when nothing changed — most edits touch no rule.
      const entries = syncMessageRulesEntry(s.worldDraft.entries, doc, s.worldDraft.language || contentLanguage(i18n.language));
      // The first document on a card that only had the platform's chat (the
      // player screen hands one over the moment a part is added to it): the
      // compiled frontend is made with it, or the recompile below — which
      // only ever overwrites a generated one — would leave the screen empty.
      const previous = s.worldDraft.rootComponent;
      const firstDoc = doc && !s.worldDraft.uiDoc && classifyInterface(previous) !== "handwritten";
      const rootComponent = firstDoc ? (() => {
        const files = { ...(previous?.files ?? {}) };
        delete files["index.tsx"];
        const built = compileUiDoc(doc);
        return {
          id: previous?.id || crypto.randomUUID(),
          name: previous?.name || "Interface",
          assetLoading: previous?.assetLoading,
          entryFile: built.entryFile,
          files: { ...files, ...built.files },
          updatedAt: new Date().toISOString(),
          generatedFrom: "uiDoc" as const,
        };
      })() : null;
      return {
        ...commitDraft(s, {
          ...s.worldDraft,
          uiDoc: doc,
          ...(rootComponent ? { rootComponent } : {}),
          ...(entries !== s.worldDraft.entries ? { entries } : {}),
          ...(reconciled.variables !== s.worldDraft.variables ? { variables: reconciled.variables } : {}),
        }),
        pendingAutoVariables: reconciled.stillPending,
      };
    });
    // The board's interface block renders rootComponent, which until now was
    // only recompiled at save — so the "live" preview showed the card as of
    // the last save, which is not what live means. Debounced: a drag emits
    // dozens of edits a second and Sucrase + a shadow-root remount per frame
    // would make the canvas feel like wading.
    scheduleUiDocRecompile();
  },

  makeAutoVariable: (name, type, defaultValue, extra) => {
    const s = get();
    const unique = uniqueVariableName(name, s.worldDraft.variables);
    const created: Variable = withPreciseTrackingDefault({
      id: crypto.randomUUID(),
      name: unique,
      type,
      defaultValue,
      description: extra?.description ?? "",
      // The rule names the variable, so it is written once the name is final
      // (a second 「你的名字」 is 「你的名字 2」).
      ...(extra?.rule ? { behaviorRules: extra.rule(unique) } : extra?.behaviorRules ? { behaviorRules: extra.behaviorRules } : {}),
      ...(extra?.aiAccess ? { aiAccess: extra.aiAccess } : {}),
    });
    set((st) => ({
      ...commitDraft(st, { ...st.worldDraft, variables: [...st.worldDraft.variables, created] }),
      pendingAutoVariables: [...st.pendingAutoVariables, created.id],
    }));
    return { id: created.id, name: unique };
  },

  syncAutoVariableName: (variableId, oldText, newText, fallback, rule) =>
    set((s) => {
      const next = autoRenameFor({ world: s.worldDraft, variableId, oldText, newText, fallback });
      if (!next) return {};
      return commitDraft(s, {
        ...s.worldDraft,
        variables: s.worldDraft.variables.map((v) => (v.id === variableId
          ? { ...v, name: next, ...(rule && v.behaviorRules ? { behaviorRules: rule(next) } : {}) }
          : v)),
      });
    }),

  adoptUiDoc: (template) =>
    set((s) => {
      if (s.worldDraft.uiDoc) return {};
      const previous = s.worldDraft.rootComponent;
      const files = { ...(previous?.files ?? {}) };

      // A card that already HAS a frontend keeps it — the player only ever
      // sees one frontend, so opening the builder re-expresses that same
      // frontend instead of starting a rival. The existing code becomes the
      // document's BASE layer: rendered unscaled underneath, imported by the
      // generated entry, and restored exactly by "export to code". Nothing is
      // lost, nothing needs a scary confirmation.
      let doc: import("@yumina/engine").UiDoc;
      if (classifyInterface(previous) === "handwritten" && previous) {
        let baseFile = previous.entryFile || "index.tsx";
        if (baseFile === "index.tsx") {
          // The generated entry claims index.tsx, so the original moves one
          // name over. Content is untouched; sibling files keep their names.
          baseFile = "_base.tsx";
          for (let i = 2; baseFile in files; i++) baseFile = `_base-${i}.tsx`;
          files[baseFile] = files["index.tsx"]!;
        }
        delete files["index.tsx"];
        doc = {
          version: 1,
          entryPageId: "page-1",
          // No starting transcript/composer: the base already has its own.
          pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }],
          base: { file: baseFile },
        };
      } else {
        delete files["index.tsx"];
        doc = template ?? startingUiDoc();
      }

      // Compile NOW rather than leaving the entry file to save time: an
      // adopted card whose board block said "Entry file 'index.tsx' not
      // found" until the first save looked broken at the exact moment the
      // creator was being sold on the builder.
      const built = compileUiDoc(doc);
      return commitDraft(s, {
        ...s.worldDraft,
        uiDoc: doc,
        rootComponent: {
          id: previous?.id || crypto.randomUUID(),
          name: previous?.name || "Interface",
          assetLoading: previous?.assetLoading,
          entryFile: built.entryFile,
          files: { ...files, ...built.files },
          updatedAt: new Date().toISOString(),
          generatedFrom: "uiDoc",
        },
      });
    }),

  /**
   * Themes are a document edit, so a card with no document gets one — its only
   * content being the theme, with `surface: "chat"` for the platform's own chat
   * underneath. That is the same document a creator would later add elements
   * to, so picking a look is the first rung of the builder rather than a
   * feature beside it.
   *
   * A card that already HAS a frontend, hand-written or arranged, keeps every
   * bit of it: only `theme` is replaced. Passing null clears the theme and
   * gives the card the platform's default look back.
   */
  applyUiTheme: (choice) =>
    set((s) => {
      const theme = choice ? buildUiTheme(choice) : null;
      if (choice && !theme) return {};
      const current = s.worldDraft.uiDoc;
      if (!current) {
        if (!theme) return {};
        const doc: import("@yumina/engine").UiDoc = {
          version: 1,
          entryPageId: "page-1",
          // An empty page: the arrangement is the stock chat underneath, and
          // this is where an element would land if one were ever added.
          pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }],
          surface: "chat",
          theme,
        };
        const previous = s.worldDraft.rootComponent;
        const files = { ...(previous?.files ?? {}) };
        delete files["index.tsx"];
        const built = compileUiDoc(doc);
        return commitDraft(s, {
          ...s.worldDraft,
          uiDoc: doc,
          rootComponent: {
            id: previous?.id || crypto.randomUUID(),
            name: previous?.name || "Interface",
            assetLoading: previous?.assetLoading,
            entryFile: built.entryFile,
            files: { ...files, ...built.files },
            updatedAt: new Date().toISOString(),
            generatedFrom: "uiDoc",
          },
        });
      }
      // Keep the creator's own additions: free CSS and uploaded fonts belong to
      // the card, not to whichever theme is on it this minute.
      const kept = { fonts: current.theme?.fonts, css: current.theme?.css };
      const nextTheme: import("@yumina/engine").UiTheme | undefined = theme
        ? { ...theme, ...(kept.fonts ? { fonts: kept.fonts } : {}), ...(kept.css ? { css: kept.css } : {}) }
        : (kept.fonts || kept.css ? { ...(kept.fonts ? { fonts: kept.fonts } : {}), ...(kept.css ? { css: kept.css } : {}) } : undefined);
      const doc = { ...current, ...(nextTheme ? { theme: nextTheme } : {}) };
      if (!nextTheme) delete (doc as { theme?: unknown }).theme;
      const next = commitDraft(s, { ...s.worldDraft, uiDoc: doc });
      scheduleUiDocRecompile();
      return next;
    }),

  addPageTemplate: (templateId, words) => {
    const start = get();
    if (start.readOnlyInspect || start.guestMode) return null;
    const tpl = getUiPageTemplate(templateId);
    if (!tpl) return null;
    if (!start.worldDraft.uiDoc) {
      if (classifyInterface(start.worldDraft.rootComponent) === "handwritten") {
        get().adoptUiDoc();
      } else {
        // The chat becomes a page of its own — transcript and input as parts —
        // rather than the platform chat left underneath. Underneath, its input
        // showed below an opening page and a player could type past 填名字.
        set((s) => {
          const base = startingUiDoc();
          const doc: import("@yumina/engine").UiDoc = {
            ...base,
            pages: base.pages.map((p) => ({ ...p, name: words.strings.chatPageName ?? p.name, background: undefined })),
          };
          const previous = s.worldDraft.rootComponent;
          const files = { ...(previous?.files ?? {}) };
          delete files["index.tsx"];
          const built = compileUiDoc(doc);
          return commitDraft(s, {
            ...s.worldDraft,
            uiDoc: doc,
            rootComponent: {
              id: previous?.id || crypto.randomUUID(),
              name: previous?.name || "Interface",
              assetLoading: previous?.assetLoading,
              entryFile: built.entryFile,
              files: { ...files, ...built.files },
              updatedAt: new Date().toISOString(),
              generatedFrom: "uiDoc",
            },
          });
        });
      }
    }
    // A card that picked a theme without building a screen has the platform
    // chat underneath and an empty page on top. An opening page over that
    // would leave the chat's input showing below it, so the chat becomes a
    // page of parts first (same look: the theme's tokens drive both).
    {
      const current = get().worldDraft.uiDoc;
      const only = current?.pages.length === 1 ? current.pages[0] : undefined;
      if (current && current.surface === "chat" && !current.base && only && only.elements.length === 0) {
        const parts = startingUiDoc(only.height).pages[0]!.elements;
        const { surface: _stock, ...rest } = current;
        get().setUiDoc({ ...rest, pages: [{ ...only, name: words.strings.chatPageName ?? only.name, elements: parts }] });
      }
    }
    const s = get();
    const doc = s.worldDraft.uiDoc;
    if (!doc) return null;

    // What the player picks before the story is theirs: kept across an
    // opening switch, readable (not rewritable) by the AI. What a play page
    // shows (a bag, an inbox) is the story's, and the AI keeps it up to date.
    const opening = tpl.place !== "play";
    const variables = [...s.worldDraft.variables];
    // A card that already tracks the same thing under its own name (a layout's
    // 「当前位置」) keeps using it: the template is pointed at that variable
    // instead of growing a second one nothing else moves.
    const varMap: Record<string, string> = {};
    for (const v of tpl.variables) {
      if (variables.some((x) => x.id === v.id)) continue;
      const names = SAME_THING[v.id];
      const twin = names && variables.find((x) => x.type === v.type && names.includes(x.name.trim().toLowerCase()));
      if (twin) varMap[v.id] = twin.id;
    }
    const ensure = (v: { id: string; type: Variable["type"]; defaultValue: unknown; min?: number; max?: number; readOnly?: boolean }) => {
      if (variables.some((x) => x.id === v.id) || varMap[v.id]) return;
      const seeded = v.type === "string" && typeof words.varDefaults?.[v.id] === "string" ? words.varDefaults[v.id]! : v.defaultValue;
      variables.push(withPreciseTrackingDefault<Variable>({
        id: v.id,
        name: uniqueVariableName(words.varNames[v.id] ?? v.id, variables),
        type: v.type,
        defaultValue: seeded as Variable["defaultValue"],
        ...(v.type === "json" ? { defaultValueText: JSON.stringify(seeded) } : {}),
        ...(v.min !== undefined ? { min: v.min } : {}),
        ...(v.max !== undefined ? { max: v.max } : {}),
        ...(opening ? { scope: "setup" as const } : {}),
        ...(opening || v.readOnly ? { aiAccess: "read" as const } : {}),
        ...(words.varRules[v.id] ? { behaviorRules: words.varRules[v.id] } : {}),
      }));
    };
    for (const v of tpl.variables) ensure(v);

    // A status page shows what the card already tracks: its numbers first,
    // then its words, leaving out what the player filled in before the story
    // and the templates' own bookkeeping. A card that tracks nothing yet gets
    // the three most cards start with.
    let stats: Array<{ id: string; label: string; type: "number" | "string"; max?: number }> | undefined;
    if (templateId === "status") {
      const own = new Set(["draws_left", "points_left", "reply_draft", "new_item", "new_message", "new_clue", "unlock_note", "accused", "roll", "actions_left"]);
      // A picture's ref is not something to read on a status page.
      const isPicture = (v: Variable) => /portrait|avatar|image|立绘|立繪|头像|頭像|图片|圖片|立ち絵|画像|retrato|imagen/i.test(`${v.id} ${v.name}`)
        || (typeof v.defaultValue === "string" && /^(@asset|https?:|\/cdn\/)/.test(v.defaultValue));
      const pick = (type: "number" | "string") => variables
        .filter((v) => v.type === type && v.scope !== "setup" && !own.has(v.id) && !v.id.startsWith("$") && !isPicture(v))
        .map((v) => ({ id: v.id, label: v.name, type, ...(type === "number" && typeof v.max === "number" ? { max: v.max } : {}) }));
      stats = [...pick("number").slice(0, 4), ...pick("string").slice(0, 2)];
      if (stats.length === 0) {
        ensure({ id: "health", type: "number", defaultValue: 100, min: 0, max: 100 });
        ensure({ id: "stamina", type: "number", defaultValue: 100, min: 0, max: 100 });
        ensure({ id: "location", type: "string", defaultValue: "" });
        stats = ["health", "stamina", "location"].map((id) => {
          const v = variables.find((x) => x.id === id)!;
          return { id, label: v.name, type: v.type as "number" | "string", ...(id !== "location" ? { max: 100 } : {}) };
        });
      }
    }
    // The openings in the order switchGreeting counts them (world-preview's
    // collectGreetings): enabled greeting entries with text, by position.
    const openingEntries = (s.worldDraft.entries ?? [])
      .filter((e) => e.role === "greeting" && e.enabled !== false && (e.content ?? "").trim())
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const greetings = openingEntries
      .map((e, i) => {
        const body = (e.content ?? "").replace(/\{\{[^}]*\}\}/g, "").replace(/[*_#>`~\[\]<>]/g, "").replace(/\s+/g, " ").trim();
        const name = (e.name ?? "").trim();
        const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
        if (name && !GENERIC_GREETING_NAME.test(name)) return { title: name, preview: clip(body, 42) };
        // An opening still called 「开场白 2」 or 「新建词条」 says nothing about
        // itself; its own first sentence does.
        const cut = body.search(/[。！？!?]|[.,，]\s/);
        const first = (cut > 0 ? body.slice(0, cut) : body).trim();
        if (!first) return { title: words.openingTitle(i + 1), preview: "" };
        return { title: clip(first, 16), preview: clip(body.slice(first.length).replace(/^[。！？!?.,，\s]+/, ""), 42) };
      })
      .map((card, i) => ({ id: openingEntries[i]!.id, ...card }));
    const summary = ["opening", "draw", "player_name", "gender", "age", "address", "origin", "difficulty", "str", "agi", "cha", "wit"]
      .map((id) => variables.find((v) => v.id === (varMap[id] ?? id)))
      .filter((v): v is Variable => Boolean(v))
      .map((v) => ({ id: v.id, label: v.name }));
    const pageId = `${templateId}-${crypto.randomUUID().slice(0, 6)}`;
    const inserted = insertPageTemplate(doc, tpl, {
      strings: words.strings,
      greetings,
      summary,
      cardName: s.worldDraft.name ?? "",
      ...(stats ? { stats } : {}),
    }, pageId, varMap);
    // A confirm page made earlier lists what this page asks for too.
    const confirmed = words.confirmStrings ? refreshConfirmSummary(inserted, summary, words.confirmStrings) : inserted;
    // Its text boxes as tall as their words: words sit at the top of a box,
    // so this changes nothing on screen — only the outline a creator selects,
    // which was a tall box around a short title.
    // A card whose every page wears the same picture is wearing a look: the
    // new page puts it on too, rather than standing out in the template's
    // own colour until the creator noticed and copied it over by hand.
    const existing = doc.pages;
    const shared = existing[0]?.background?.kind === "image"
      && existing.every((p) => JSON.stringify(p.background) === JSON.stringify(existing[0]!.background))
      ? existing[0]!.background : undefined;
    const next = {
      ...confirmed,
      pages: confirmed.pages.map((p) => (p.id === pageId
        ? { ...p, ...(shared ? { background: shared } : {}), elements: p.elements.map((el) => (el.type === "text" ? fitTextBox(el, p, { hug: true }) : el)) }
        : p)),
    };
    set((st) => commitDraft(st, { ...st.worldDraft, variables, uiDoc: next }));
    scheduleUiDocRecompile();
    return pageId;
  },

  /**
   * An official arrangement, installed with the parts it is made of.
   *
   * A layout bound to variables a card does not have is a picture of a layout:
   * the meter sits at its fallback for ever and the portrait can never change.
   * So the variables come with it — created only when missing, by name, so
   * picking the layout twice does not leave a card with two affection meters.
   * They are ordinary variables afterwards: visible on the board, editable,
   * drivable by a behaviour, and removable if the creator wants them gone.
   */
  applyUiTemplate: (templateId, strings, variableNames, variableDefaults) =>
    set((s) => {
      if (s.readOnlyInspect || s.guestMode) return {};
      const previous = s.worldDraft.rootComponent;
      // What the card was arranged as before this switch — the leftovers are
      // measured against it once the new arrangement is in.
      const previousDoc = s.worldDraft.uiDoc;
      const previousTemplateId = detectUiTemplate(previousDoc);
      const leftoversAfter = (next: WorldDefinition) => {
        const found = findTemplateLeftovers({ world: next, previousDoc, previousTemplateId, variableNames });
        return found.length > 0 ? { variableIds: found.map((v) => v.id), names: found.map((v) => v.name) } : null;
      };

      if (!templateId) {
        // Back to the platform's chat. The variables stay: they may be driving
        // a behaviour by now, and silently deleting someone's state because
        // they changed their mind about a layout is not a thing to do. The
        // ones that provably drive nothing are listed for the creator instead.
        if (!s.worldDraft.uiDoc) return {};
        // The opening pages the creator added are not the layout's: they stay.
        const doc = carryOpeningChain(previousDoc, {
          version: 1, entryPageId: "page-1",
          pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }],
          surface: "chat",
        });
        const built = compileUiDoc(doc);
        const nextDraft: WorldDefinition = {
          ...s.worldDraft,
          uiDoc: doc,
          rootComponent: {
            id: previous?.id || crypto.randomUUID(), name: previous?.name || "Interface",
            assetLoading: previous?.assetLoading,
            entryFile: built.entryFile,
            files: { ...(previous?.files ?? {}), ...built.files },
            updatedAt: new Date().toISOString(), generatedFrom: "uiDoc",
          },
        };
        return { ...commitDraft(s, nextDraft), templateLeftovers: leftoversAfter(nextDraft) };
      }

      const template = getUiTemplate(templateId);
      if (!template) return {};

      // The layout declares what it is bound to; the card supplies the names.
      // Reusing a variable that already matches by name AND type is what keeps
      // picking the layout twice from leaving a card with two affection meters.
      const variables = [...s.worldDraft.variables];
      const variableIds: Record<string, string> = {};
      for (const need of template.needs) {
        const name = (variableNames[need.key] ?? need.key).trim();
        const existing = variables.find((variable) => variable.name.trim() === name && variable.type === need.type);
        if (existing) {
          variableIds[need.key] = existing.id;
          continue;
        }
        // A localized starting value wins over the engine's, but only for the
        // string variables it can sensibly speak for.
        const localized = need.type === "string" ? variableDefaults?.[need.key] : undefined;
        const created: Variable = {
          id: crypto.randomUUID(), name, type: need.type, description: "",
          // The portrait starts as whatever art the card already has, so a card
          // with a cover shows it the moment the layout lands.
          defaultValue: need.fromCover
            ? (s.worldDraft.avatar || need.defaultValue)
            : (localized ?? need.defaultValue),
          ...(need.min !== undefined ? { min: need.min } : {}),
          ...(need.max !== undefined ? { max: need.max } : {}),
          // A json variable is authored as text and read as a value; writing
          // only the value leaves the editor's own field blank.
          ...(need.type === "json" ? { defaultValueText: JSON.stringify(need.defaultValue) } : {}),
        };
        const tracked = withPreciseTrackingDefault(created);
        variables.push(tracked);
        variableIds[need.key] = tracked.id;
      }
      // The layout's own colours come with it: there is no other colour
      // picker, so choosing the arrangement is choosing its look.
      const theme = template.look ? buildUiTheme(template.look) : null;
      const doc = carryOpeningChain(previousDoc, template.build({
        strings,
        variableIds,
        ...(theme ? { theme } : {}),
      }));
      const built = compileUiDoc(doc);
      const nextDraft: WorldDefinition = {
        ...s.worldDraft,
        variables,
        uiDoc: doc,
        rootComponent: {
          id: previous?.id || crypto.randomUUID(), name: previous?.name || "Interface",
          assetLoading: previous?.assetLoading,
          entryFile: built.entryFile,
          files: { ...(previous?.files ?? {}), ...built.files },
          updatedAt: new Date().toISOString(), generatedFrom: "uiDoc",
        },
      };
      return { ...commitDraft(s, nextDraft), templateLeftovers: leftoversAfter(nextDraft) };
    }),

  discardTemplateLeftovers: () =>
    set((s) => {
      const ids = new Set(s.templateLeftovers?.variableIds ?? []);
      if (ids.size === 0) return { templateLeftovers: null };
      // Re-checked at the moment of clearing, not at the moment of offering: a
      // variable that grew a behaviour in between is no longer a leftover.
      const gone = s.worldDraft.variables.filter((v) => ids.has(v.id) && getVariableIdUsage(s.worldDraft, v).references.length === 0);
      const goneIds = new Set(gone.map((v) => v.id));
      if (goneIds.size === 0) return { templateLeftovers: null };
      return {
        ...commitDraft(s, { ...s.worldDraft, variables: s.worldDraft.variables.filter((v) => !goneIds.has(v.id)) }),
        templateLeftovers: null,
      };
    }),

  keepTemplateLeftovers: () => set({ templateLeftovers: null }),

  exportUiDocToCode: () =>
    set((s) => {
      if (!s.worldDraft.uiDoc || !s.worldDraft.rootComponent) return {};
      const { generatedFrom: _generatedFrom, ...rootComponent } = s.worldDraft.rootComponent;
      const { uiDoc, ...rest } = s.worldDraft;

      // A wrapped card restores to exactly what it was: the preserved base
      // becomes the entry again and the generated wrapper is dropped (any
      // overlay elements with it — the export dialog says so). This is what
      // makes adoption a round trip instead of a one-way door.
      const baseFile = uiDoc.base?.file;
      if (baseFile && rootComponent.files?.[baseFile]) {
        const files = { ...rootComponent.files };
        delete files["index.tsx"];
        return commitDraft(s, {
          ...rest,
          rootComponent: {
            ...rootComponent,
            entryFile: baseFile,
            files,
            updatedAt: new Date().toISOString(),
          },
        });
      }

      // The generated files stay exactly as they are and simply stop being
      // regenerated. Dropping `generatedFrom` is what hands over ownership —
      // from here the save path leaves this card's frontend alone.
      return commitDraft(s, { ...rest, rootComponent });
    }),

  applyGraphPatch: (patch) =>
    set((s) => {
      if (patch.op === "add-node") {
        // Store owns id minting + insertion for new nodes.
        const id = crypto.randomUUID();
        if (patch.node.kind === "variable") {
          const v = withPreciseTrackingDefault<Variable>({ id, name: "New variable", type: "number", defaultValue: 0 });
          return commitDraft(s, { ...s.worldDraft, variables: [...s.worldDraft.variables, v] });
        }
        if (patch.node.kind === "rule") {
          const r: Reaction = { id, name: "New behavior", when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true };
          return commitDraft(s, { ...s.worldDraft, reactions: [...(s.worldDraft.reactions ?? []), r] });
        }
        return s;
      }
      return commitDraft(s, applyGraphEdit(s.worldDraft, patch));
    }),

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

  addReaction: (worldbookId) => {
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
        ...(worldbookId ? { worldbookId } : {}),
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

  duplicateReaction: (id, copySuffix = "copy") => {
    const source = get().worldDraft.reactions?.find(reaction => reaction.id === id);
    if (!source || get().guestMode || get().readOnlyInspect) return null;
    const newId = crypto.randomUUID();
    set(s => {
      const reactions = [...(s.worldDraft.reactions ?? [])];
      const index = reactions.findIndex(reaction => reaction.id === id);
      if (index < 0) return s;
      const src = reactions[index]!;
      const copy = { ...structuredClone(src), id: newId, name: nextCopyName(src.name, reactions, copySuffix) };
      reactions.splice(index + 1, 0, copy);
      return commitDraft(s, { ...s.worldDraft, reactions });
    });
    return newId;
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
    beginEditorDocument();
    loadAbort?.abort();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    // The template's packs are authored content, so they arrive in the
    // language the creator is working in rather than in English.
    const draft = template.build(i18n.language);
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
      serverCreatorId: null,
      saving: false,
      loadingWorld: false,
      baseUpdatedAt: null,
      _baseSchema: null,
      isDirty: false,
      layoutDirty: false,
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
    clearStoredDraft();
  },

  loadWorldDefinition: (def, options) => {
    retireRecoveryOffer();
    loadAbort?.abort();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    const preserveServerState = options?.preserveServerState ?? false;
    if (!preserveServerState) beginEditorDocument();
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
      // The canvas arrangement came with the import; a pending layout flag
      // from the document it replaced has nothing left to describe.
      layoutDirty: false,
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
    clearStoredDraft();
    // An import is an unsaved edit like any other: arm the recovery write and
    // the autosave. Judged against a clean state so a replaced document that
    // was already dirty still starts the timer.
    const next = get();
    scheduleEditPersistence({ ...next, isDirty: false }, next.worldDraft);
  },

  applyImportedCover: async (blob) => {
    // The thumbnail endpoint needs an owned, server-side world. Create one
    // first if this is a fresh import (mirrors the manual cover-upload flow).
    let id = get().serverWorldId;
    if (!id) {
      if (!get().worldDraft.name) {
        get().setField("name", i18n.t("editor:shell.untitledWorld", { defaultValue: "Untitled World" }));
      }
      await get().saveDraft();
      id = get().serverWorldId;
    }
    if (!id) return; // save failed — saveDraft already surfaced the error

    try {
      const file = new File([blob], "cover.png", { type: "image/png" });
      const data = await uploadAssetWithPresignedUrl<{ thumbnailUrl: string; previousUpdatedAt?: string | null; updatedAt?: string }>({
        file,
        preferredType: "image",
        resizeImageMaxDimension: 2048, // card cover — don't store the full original
        prepareUrl: `${apiBase}/api/worlds/${id}/thumbnail`,
        registerUrl: `${apiBase}/api/worlds/${id}/thumbnail/confirm`,
        registerBody: ({ key }) => ({ key }),
      });
      adoptOwnWriteToken(id, data);
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
          worldbookId: (id) => worldbookIdMap.get(id) ?? id,
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
        if (s.worldDraft.uiDoc) mergedRoot = compileEditorUiDoc(s.worldDraft.uiDoc, mergedRoot);
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
        if (s.worldDraft.uiDoc) rootComponent = compileEditorUiDoc(s.worldDraft.uiDoc, rootComponent);
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

  setGalleryImages: (images) => set((s) => metadataUpdate(s, { galleryImages: images })),
  setAnnouncement: (value) => set((s) => metadataUpdate(s, { announcement: value })),
  setApproxTime: (value) => set((s) => metadataUpdate(s, { approxTime: value })),
  setTags: (tags) => set((s) => metadataUpdate(s, { tags })),
  setLanguage: (value) => set((s) => metadataUpdate(s, { language: value })),
  setVariantLabel: (value) => set((s) => metadataUpdate(s, { variantLabel: value })),

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
    const { worldDraft, serverWorldId, language, variantLabel, baseUpdatedAt, galleryImages, announcement, approxTime, tags } = started;
    const sessionAtSave = editorSession;
    const isCurrentSession = () => sessionAtSave === editorSession;
    const invalidVariable = invalidJsonDefault(worldDraft.variables);
    if (invalidVariable) {
      showWorldSaveError(i18n.t("editor:variables.jsonSaveBlocked", { name: invalidVariable.name }));
      return false;
    }
    const draftAtSave = worldDraft; // snapshot for race-condition check
    const draftSeqAtSave = draftWriteSeq;
    const documentAtSave = editorDocumentEpoch;
    const saveToken = Symbol("save");
    activeSaveToken = saveToken;
    let currentServerId = serverWorldId;
    const isCurrentCard = () => editorDocumentEpoch === documentAtSave && get().worldDraft.id === draftAtSave.id && get().serverWorldId === currentServerId;
    const hasNoDrift = () => {
      const latest = get();
      // Metadata setters do not replace worldDraft. Their edits must remain
      // pending too; a content response cannot acknowledge newer metadata.
      return latest.worldDraft === draftAtSave && latest.language === language && latest.variantLabel === variantLabel &&
        latest.galleryImages === galleryImages && latest.announcement === announcement && latest.approxTime === approxTime && latest.tags === tags;
    };
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

      // The interface document, if this card has one, compiles into the
      // rootComponent — which stays the only visual-layer input the runtime
      // reads, so nothing downstream learns that uiDoc exists. It runs BEFORE
      // the TSX precompile below so the freshly generated file gets hashed and
      // precompiled like any other, and the compiler is deterministic, so a
      // save that changed nothing about the interface produces the same
      // filesHash and no recompile.
      //
      // The same composition policy drives imports and the debounced preview,
      // so saving cannot unmount a bundle that is visible in the editor.
      if (schemaWithoutAvatar.uiDoc) {
        try {
          schemaWithoutAvatar.rootComponent = compileEditorUiDoc(schemaWithoutAvatar.uiDoc, schemaWithoutAvatar.rootComponent);
        } catch (err) {
          // A doc that will not compile must not cost the creator the rest of
          // the save — their entries, variables and behaviours are in this same
          // payload. The old interface stays live and the editor still has the
          // doc to fix.
          //
          // But it has to SAY so. Silently keeping the previous interface means
          // a creator watches "Saved" appear and then finds the card unchanged
          // in playtest, with nothing anywhere connecting the two.
          console.error("[uiDoc] compile failed; keeping the previous interface", err);
          feedback.error(
            i18n.t("editor:interface.compileFailed", {
              defaultValue:
                "Your interface could not be built, so the card still shows the previous one. Everything else was saved.",
            }),
          );
        }
      }
      const payload: Record<string, unknown> = {
        name: cleanDraft.name || i18n.t("editor:shell.untitledWorld", { defaultValue: "Untitled World" }),
        description: cleanDraft.description,
        schema: schemaWithoutAvatar as unknown as Record<string, unknown>,
        language: language || null,
        variantLabel: variantLabel || null,
        // Optimistic-concurrency token: lets the server reject a stale whole-blob
        // save that would clobber the Studio agent's writes (draft worlds). Null
        // is ignored server-side. The POST (new-world) path ignores it too.
        baseUpdatedAt,
        galleryImages,
        tags,
        announcement: announcement || null,
        approxTime: approxTime || null,
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
                const { transformTSX } = await import("@/lib/tsx/tsx-compiler");
                code = transformTSX(rcFiles[rcEntry] ?? rcFiles[keys[0] ?? ""] ?? "").code || "";
              } else {
                const { bundleTSX } = await import("@/lib/tsx/tsx-bundler");
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

      if (!isCurrentCard()) return false;
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
          const noDriftDuringSave = hasNoDrift();
          settleStoredDraftAfterSave(draftSeqAtSave, noDriftDuringSave);
          // Advance the ancestor with the version this request saved, not any
          // edits made while it was in flight. Keep the client's representation:
          // server normalization remains a server-side change on the next merge,
          // and a published PATCH may return the old live schema, not the saved
          // working draft. A stale ancestor misclassifies already-saved UI files
          // as new local edits and lets them overwrite later agent changes.
          set({
            _baseSchema: structuredClone(cleanDraft),
            ...(noDriftDuringSave ? { isDirty: false, layoutDirty: false } : {}),
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
              if (get().layoutDirty) merged.graphLayout = get().worldDraft.graphLayout;
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
              // A clean merge is saved right away — the creator pressed Save,
              // and "it merged, now press it again" is an errand, not an
              // outcome. Once only: a second STALE on the retry means the
              // world is changing under us faster than we can follow, and
              // that is something to tell them, not something to loop on.
              if (conflicts.length === 0 && !staleMergeRetryInFlight) {
                staleMergeRetryInFlight = true;
                try {
                  // saveDraft refuses to run while one is in flight — and this
                  // one still is, from its own point of view. The retry is the
                  // tail of the same save, so it gets the flag back.
                  set({ saving: false });
                  if (await get().saveDraft()) {
                    feedback.notice(tr("editor:save.mergedSavedToast", "Merged changes from elsewhere and saved"));
                    if (get().serverWorldId) captureHubEvent("studio_blueprint_saved", { world_id: get().serverWorldId!, trigger: "merged_retry" });
                    return true;
                  }
                  // The retry showed its own pill for whatever stopped it.
                  return false;
                } finally {
                  staleMergeRetryInFlight = false;
                }
              }
              // The save did NOT go through: say so, say it stayed merged, and
              // put the save one click away rather than back in the header.
              feedback.error(
                conflicts.length > 0
                  ? tr("editor:save.mergedConflictsToast", "Merged — your version was kept")
                  : tr("editor:save.mergedToast", "Merged the assistant's changes — save again"),
                {
                  label: tr("editor:save.saveNow", "Save now"),
                  onClick: () => void useEditorStore.getState().saveDraft(),
                },
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
          if (!isCurrentCard() || !canApplyServerSnapshot(data.updatedAt, started, get())) return false;
          dismissSaveError?.();
          // Only clear dirty if no changes were made during the save
          const updates: Partial<EditorState> = {
            serverWorldId: data.id,
            serverCreatorId: null,
            _baseSchema: structuredClone(cleanDraft),
          };
          const savedToken = validServerToken(data.updatedAt);
          if (savedToken) {
            updates.baseUpdatedAt = savedToken;
          }
          const noDriftDuringSave = hasNoDrift();
          if (noDriftDuringSave) {
            updates.isDirty = false;
            updates.layoutDirty = false;
          }
          currentServerId = data.id;
          set(updates);
          settleStoredDraftAfterSave(draftSeqAtSave, noDriftDuringSave);
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
      // Release our lock even after navigation, without clearing a newer save.
      if (activeSaveToken === saveToken) activeSaveToken = null;
      if (isCurrentSession()) set({ saving: false });
    }
  }),

  clearDraft: () => {
    retireRecoveryOffer();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    clearStoredDraft();
    set({
      isDirty: false,
      layoutDirty: false,
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

  discardUnsavedChanges: () => {
    // Fields still holding typed text commit first, so the retire below
    // covers their recovery writes too instead of racing them.
    try { flushPendingEditorFields(); } catch { /* fields are on their own */ }
    retireRecoveryOffer();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    if (newWorldSaveTimer) { clearTimeout(newWorldSaveTimer); newWorldSaveTimer = null; }
    stopServerAutosave();
    // The leave guard left a copy behind as it caught the navigation, and the
    // debounced writer may have one queued. Both go: the dialog said the
    // changes would be lost, and a "recover last time's changes?" offer on
    // the next open contradicts it. A crash or a reload never comes through
    // here, so their recovery copy survives.
    clearStoredDraft();
    discardedWorldId = get().serverWorldId;
    set({ isDirty: false, layoutDirty: false });
  },

  releaseDiscardedWorld: (worldId: string) => {
    if (discardedWorldId !== worldId) return;
    discardedWorldId = null;
    // Still the discarded edits in memory: without this an in-app return to
    // the card showed them again, now looking saved.
    if (get().serverWorldId === worldId) set({ serverWorldId: null, serverCreatorId: null, isDirty: false, layoutDirty: false });
  },

  stopAutosave: () => {
    // Called from every editor route's unmount cleanup — leaving the editor
    // makes a recovery offer meaningless, and a persistent pill must not
    // linger over Discover.
    //
    // The route's cleanup runs before its children's. A field still holding
    // typed text commits it as it unmounts, and that commit used to restart
    // the 60s server autosave and queue a recovery write AFTER this had
    // stopped them — a timer saving a card nobody had open, and a "recover?"
    // offer for a card that was just left. So: commit the fields now, while
    // the editor is still here, and ignore persistence for anything that
    // still commits during the rest of this unmount.
    // Best effort: a field that throws while committing must not stop the
    // timers below from being cleared.
    try { flushPendingEditorFields(); } catch { /* fields are on their own */ }
    persistenceDetached = true;
    autosaveVisit++;
    setTimeout(() => { persistenceDetached = false; }, 0);
    retireRecoveryOffer();
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    if (newWorldSaveTimer) { clearTimeout(newWorldSaveTimer); newWorldSaveTimer = null; }
    stopServerAutosave();
  },
}));

/**
 * A write this editor made through another endpoint (the cover) moves the
 * world's revision. When the revision it replaced is the one the editor holds,
 * the new one is ours: adopt it, or the next save reads as a conflict and
 * reports "merged changes from elsewhere" that never happened. Anything else
 * in between leaves the token alone, so a real conflict still merges.
 */
export function adoptOwnWriteToken(worldId: string, data: { previousUpdatedAt?: string | null; updatedAt?: string | null }) {
  const state = useEditorStore.getState();
  if (state.serverWorldId !== worldId || !state.baseUpdatedAt) return;
  const next = validServerToken(data.updatedAt);
  const previous = validServerToken(data.previousUpdatedAt);
  if (!next || !previous) return;
  if (Date.parse(previous) !== Date.parse(state.baseUpdatedAt)) return;
  useEditorStore.setState({ baseUpdatedAt: next });
}
