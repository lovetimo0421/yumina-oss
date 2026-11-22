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
import { remapBundleAssets, remapSettings, remapVariableIdsInCode, writeSettingValue, type MergeBundleOptions } from "@/lib/bundle-install";
export type { MergeBundleOptions, VariableConflictChoice } from "@/lib/bundle-install";
import { syncMessageRulesEntry, nextBackgroundId, COVER_BACKGROUND_URL, migrateWorldDefinition, deriveSectionDefaults, deriveSectionDefaultsForEntry, officialPresetsFor, customUIToRootFiles, normalizeFolders, mergeWorldDefinition, mergeWorldValue, diffWorld, applyWorldChanges, rebaseWorldDetailed, annotateChangeBase, writeTextField, isWorldChangeList, deepEqual, WORLD_ROW_COLLECTIONS, type WorldEdit, type WorldMergeConflict, remapReactionReferences, applyGraphEdit, compileUiDoc, buildUiTheme, getUiTemplate, getUiPageTemplate, insertPageTemplate, fitTextBox, refreshConfirmSummary, carryOpeningChain, detectUiTemplate, withPreciseTrackingDefault, suggestedContinuityDelta, USER_ROOT_PATH, COMPOSED_MARKER, BUNDLE_NS_RE, generateComposedIndex, readComposedLayout, syncGreetingActions, PromptBuilder, UNPLACED_WORLDBOOK_ID, revertTurn } from "@yumina/engine";
import { materializeBehaviors } from "@/features/editor/lib/editable-behaviors";
import type { OfficialPreset } from "@yumina/engine";
import { classifyInterface, startingUiDoc } from "@/features/studio/lib/ui-doc-takeover";
import { MAX_WORLD_SAVE_BODY_BYTES, type WorldPendingEditSummary } from "@yumina/shared";
import type { WorldTemplate } from "@/lib/world-templates";
import { isPlaceholderCardName, untitledCardName } from "@/lib/world-templates";
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
import { collaboratorsPresent, liveTextKeys, overlayLiveText } from "./live-text-registry";

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

const PORTRAIT_ART_KEYS = ["avatar", "coverCrop", "galleryCoverCrop"] as const;
const LANDSCAPE_ART_KEYS = ["landscapeCover", "landscapeCoverCrop"] as const;

/** Replacing a card's contents from a file keeps the card's own artwork.
 *  Creators build cards from one base file, so the file carries the base
 *  card's banner; letting it through put the base banner on every update.
 *  The wide banner always stays the card's own (absent included). The
 *  portrait cover stays when the card has one; a card without one may take
 *  the file's. Exported for tests. */
export function keepOwnArtwork(draft: WorldDefinition, own: WorldDefinition): void {
  const take = (keys: readonly (keyof WorldDefinition)[]) => {
    for (const key of keys) {
      if (own[key] === undefined) delete draft[key];
      else (draft as unknown as Record<string, unknown>)[key] = own[key];
    }
  };
  take(LANDSCAPE_ART_KEYS);
  if (own.avatar) take(PORTRAIT_ART_KEYS);
}

/**
 * Give an entry without a usable position one behind the rest of its section.
 * Positions are never renumbered here: they are per-entry, like Figma's
 * fractional indexing (see slotPositions), and renumbering a whole section on
 * every save or delete wrote a new position into every entry — so someone
 * else's drag landing at the same time was put back. Sorting by position,
 * gaps and fractions read the same as 0, 1, 2…
 */
function normalizePositions(entries: WorldEntry[]): WorldEntry[] {
  if (entries.every((e) => typeof e.position === "number" && Number.isFinite(e.position))) return entries;
  const top = new Map<string, number>();
  for (const e of entries) {
    if (typeof e.position === "number" && Number.isFinite(e.position)) top.set(e.section, Math.max(top.get(e.section) ?? -1, e.position));
  }
  return entries.map((e) => {
    if (typeof e.position === "number" && Number.isFinite(e.position)) return e;
    const next = Math.floor(top.get(e.section) ?? -1) + 1;
    top.set(e.section, next);
    return { ...e, position: next };
  });
}

/** Positions 0, 1, 2… for one section, in position order — only when two
 *  neighbours are too close to fit anything between them. */
function renumberSection(entries: WorldEntry[], section: WorldEntry["section"]): WorldEntry[] {
  const order = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.section === section)
    .sort((a, b) => (a.e.position ?? 0) - (b.e.position ?? 0) || a.i - b.i);
  const next = new Map(order.map(({ e }, i) => [e.id, i]));
  return entries.map((e) => (next.has(e.id) && e.position !== next.get(e.id) ? { ...e, position: next.get(e.id)! } : e));
}

/** A position just behind `after` in its section: halfway to the next one. */
function positionAfter(entries: WorldEntry[], after: WorldEntry): number | null {
  const at = after.position ?? 0;
  let next: number | null = null;
  for (const e of entries) {
    if (e.id === after.id || e.section !== after.section) continue;
    const p = e.position ?? 0;
    if (p > at && (next === null || p < next)) next = p;
  }
  if (next === null) return at + 1;
  return next - at > 1e-6 ? (at + next) / 2 : null;
}

/**
 * New positions for a reorder, like Figma's fractional indexing: the entries
 * that were dragged get a position between their new neighbours and every
 * other entry keeps its own, so two people dragging different entries at the
 * same time both keep their move (a reorder that renumbered every entry let
 * the later save put everything back). Falls back to renumbering the listed
 * entries 0..n when positions are tied or too close to split.
 */
export function slotPositions(all: WorldEntry[], entryIds: string[]): Map<string, number> {
  const byId = new Map(all.map((e, i) => [e.id, { e, i }]));
  const out = new Map<string, number>();
  const sections = new Map<string, string[]>();
  for (const id of entryIds) {
    const hit = byId.get(id);
    if (!hit) continue;
    const list = sections.get(hit.e.section) ?? [];
    list.push(id);
    sections.set(hit.e.section, list);
  }
  for (const ids of sections.values()) {
    const pos = (id: string) => byId.get(id)!.e.position ?? 0;
    const current = [...ids].sort((a, b) => pos(a) - pos(b) || byId.get(a)!.i - byId.get(b)!.i);
    const rank = new Map(current.map((id, i) => [id, i]));
    // Longest run that kept its order stays where it is.
    const seq = ids.map((id) => rank.get(id)!);
    const tails: number[] = [];
    const back: number[] = new Array(seq.length).fill(-1);
    for (let i = 0; i < seq.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1; else hi = mid; }
      if (lo > 0) back[i] = tails[lo - 1]!;
      tails[lo] = i;
    }
    const stay = new Set<string>();
    for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = back[i]!) stay.add(ids[i]!);
    const next = new Map<string, number>();
    let ok = true;
    let prev: number | undefined;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      let p: number;
      if (stay.has(id)) p = pos(id);
      else {
        let after: number | undefined;
        for (let j = i + 1; j < ids.length; j++) if (stay.has(ids[j]!)) { after = pos(ids[j]!); break; }
        p = prev === undefined ? (after === undefined ? 0 : after - 1) : after === undefined ? prev + 1 : (prev + after) / 2;
      }
      if (prev !== undefined && !(p - prev > 1e-6)) ok = false;
      next.set(id, p);
      prev = p;
    }
    if (ok) for (const [id, p] of next) out.set(id, p);
    else ids.forEach((id, i) => out.set(id, i));
  }
  return out;
}

/** Positions as the array order has them, per section; an entry already in/** Positions as the array order has them, per section; an entry already in
 *  its place keeps its identity (see normalizePositions). */
function withPositionsFromOrder(entries: WorldEntry[]): WorldEntry[] {
  const next = new Map<string, number>();
  let moved = false;
  const out = entries.map((entry) => {
    const position = next.get(entry.section) ?? 0;
    next.set(entry.section, position + 1);
    if (entry.position === position) return entry;
    moved = true;
    return { ...entry, position };
  });
  return moved ? out : entries;
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
// Server autosave, Google-Docs style: save once the creator pauses, and never
// let a continuous burst of typing go longer than the max wait unsaved. A card
// whose last save was large waits longer — every save sends the whole world.
// Layout-only changes (dragging, collapsing) are cheap to lose and come in
// bursts, so they wait for a longer pause.
const SERVER_AUTOSAVE_QUIET_MS = 2000;
const SERVER_AUTOSAVE_MAX_WAIT_MS = 10_000;
const SERVER_AUTOSAVE_LARGE_QUIET_MS = 5000;
const SERVER_AUTOSAVE_LARGE_MAX_WAIT_MS = 30_000;
const SERVER_AUTOSAVE_LAYOUT_QUIET_MS = 5000;
// With someone else on the card, a structural edit (add, delete, move,
// toggle, pick an option) reaches them in under a second, like Figma: a short
// pause, and never more than two seconds of edits unsent. Text being typed
// together travels live keystroke by keystroke (features/collab/live-text),
// so its saves keep the normal pace; text someone else typed is saved by them,
// and here only after a long pause, as a backstop.
const SERVER_AUTOSAVE_COLLAB_QUIET_MS = 400;
const SERVER_AUTOSAVE_COLLAB_MAX_WAIT_MS = 2000;
const SERVER_AUTOSAVE_REMOTE_TEXT_QUIET_MS = 8000;
const LARGE_SAVE_BYTES = 1_000_000;
/** Retries after a failed autosave back off up to this. */
const SERVER_AUTOSAVE_MAX_RETRY_MS = 60_000;
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
    files[baseFile] = generateComposedIndex(folders, readComposedLayout(previous?.files[baseFile]));
  } else if (
    previous?.files["index.tsx"]?.startsWith(COMPOSED_MARKER) ||
    (folders.length > 0 && previous?.files[USER_ROOT_PATH] !== undefined)
  ) {
    // Also repairs cards previously saved with an overwritten composer: their
    // bundle files and user entry survived, but index.tsx stopped mounting them.
    files[USER_ROOT_PATH] = built.files[built.entryFile]!;
    files["index.tsx"] = generateComposedIndex(folders, readComposedLayout(previous?.files["index.tsx"]));
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

/** Merge a bundle into a world: the pure half of `importBundle`. Everything
 *  the bundle brings gets fresh ids, references are remapped, its interface is
 *  composed under `_bundles/{slug}/`, and an install record is appended. Used
 *  by the editor store and by previews that build a world without touching it.
 *
 *  Options (all optional, see MergeBundleOptions): install into a situation,
 *  replace or skip the card's screen, rewrite the pack's asset references to
 *  the card's copies, and settle same-name variables one by one. */
export function mergeBundleIntoWorld(
  world: WorldDefinition,
  incoming: YuminaBundle,
  sourceBundleId?: string,
  options: MergeBundleOptions = {},
): WorldDefinition {
  const s = { worldDraft: world };
  const bundle = remapBundleAssets(incoming, options.assetMap);
  const intoBook = options.worldbookId && (world.worldbooks ?? []).some((b) => b.id === options.worldbookId)
    ? options.worldbookId
    : undefined;
  const interfaceMode = options.interface ?? "compose";
  const installId = options.installId ?? crypto.randomUUID();
  const colorKey = options.colorKey ?? nextBundleColorKey(s.worldDraft.installedBundles?.length ?? 0);
  const existingVarIds = new Set(s.worldDraft.variables.map((v) => v.id));
  const existingVarNames = new Map(
    s.worldDraft.variables.map((v) => [v.name.toLowerCase(), v.id])
  );

  // Build variable ID remap: old bundle var ID → new ID in this world
  const varIdMap = new Map<string, string>();
  const newVars: Variable[] = [];
  const takenName = (name: string) =>
    existingVarNames.has(name.toLowerCase()) || newVars.some((v) => v.name.toLowerCase() === name.toLowerCase());

  for (const bv of bundle.variables) {
    const linked = options.variableConflicts?.[bv.id];
    if (existingVarIds.has(bv.id)) {
      // Same ID already exists → skip, map to itself
      varIdMap.set(bv.id, bv.id);
    } else if (linked?.mode === "merge" && linked.targetId && existingVarIds.has(linked.targetId)) {
      // Pointed at one of the card's own (a different name): one variable.
      varIdMap.set(bv.id, linked.targetId);
    } else if (existingVarNames.has(bv.name.toLowerCase())) {
      const choice = options.variableConflicts?.[bv.id];
      if (choice?.mode === "merge") {
        // One variable: the card's. Everything of the pack's that read or
        // wrote its own now points at it.
        varIdMap.set(bv.id, existingVarNames.get(bv.name.toLowerCase())!);
        continue;
      }
      // Both kept: the pack's under a name of its own.
      const newId = `var_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const wanted = choice?.mode === "keep" ? choice.name?.trim() : undefined;
      let newName = wanted && !takenName(wanted) ? wanted : bv.name;
      let suffix = 1;
      while (takenName(newName)) {
        newName = `${wanted || bv.name} (${suffix++})`;
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
  // Entry membership: remap to the new worldbook id, or fall back to the
  // situation the pack is going into (Core when none) if the bundle didn't
  // include that worldbook.
  const remapWorldbookId = (id: string | undefined): string | undefined =>
    id && worldbookIdMap.has(id) ? worldbookIdMap.get(id) : intoBook;
  // Variables stay the card's (a situation-scoped variable would hide the
  // pack's state from the rest of the card), but one scoped to a situation
  // the pack brought follows that situation's new id.
  for (let i = 0; i < newVars.length; i++) {
    const v = newVars[i]!;
    if (v.worldbookId) newVars[i] = { ...v, worldbookId: worldbookIdMap.get(v.worldbookId) };
  }

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
  const newReactions: Reaction[] = (bundle.reactions ?? []).map((r, i) => {
    const remapped = remapReactionReferences(r, {
      variableId: remapVarId,
      entryId: remapEntryId,
      reactionId: (id) => reactionIdMap.get(id) ?? id,
      worldbookId: (id) => worldbookIdMap.get(id) ?? id,
    });
    // Its own scope follows the situation it was in, or the one the pack is
    // going into; an unscoped one goes with the pack.
    const worldbookId = remapped.worldbookId ? worldbookIdMap.get(remapped.worldbookId) ?? intoBook : intoBook;
    const { worldbookId: _scope, ...rest } = remapped;
    return {
      ...rest,
      ...(worldbookId ? { worldbookId } : {}),
      id: reactionIdMap.get(r.id)!,
      priority: (s.worldDraft.reactions?.length ?? 0) + i,
    } as Reaction;
  });

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
      // An opening is the card's: it never goes into a situation.
      worldbookId: e.role === "greeting" && !(e.worldbookId && worldbookIdMap.has(e.worldbookId))
        ? undefined
        : remapWorldbookId(e.worldbookId),
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
  let bundleRoot = interfaceMode === "skip" ? null : bundle.rootComponent ?? null;
  if (!bundleRoot && interfaceMode !== "skip") {
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
  if (bundleRoot && Object.keys(bundleRoot.files ?? {}).length === 0) bundleRoot = null;

  // Ids the card keeps under another name than the pack's: its interface
  // reads them by id, so its own files follow.
  const changedVarIds = new Map([...varIdMap].filter(([from, to]) => from !== to));

  // Always-compose merge that preserves the runtime invariant
  // `entryFile === "index.tsx"`. The user's own root code lives in
  // __user-root.tsx; bundles live under _bundles/{slug}/; index.tsx is an
  // auto-generated composer that mounts user-root + each bundle. This
  // means importing a bundle NEVER erases the user's content — their
  // previous index.tsx is migrated into __user-root.tsx on the first
  // import and left untouched on subsequent imports. Replacing the screen
  // only changes what the composer mounts: the author's root stays a file.
  let mergedRoot = s.worldDraft.rootComponent;
  let bundleSlug: string | undefined;
  let previousRoot: InstalledBundle["previousRoot"];
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
    const layout = alreadyComposed ? readComposedLayout(currentIndex) : {};

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
      files[`_bundles/${folder}/${destName}`] = changedVarIds.size > 0 ? remapVariableIdsInCode(code, changedVarIds) : code;
    }

    // Authoritative bundle-folder list (includes any previous imports).
    const folderSet = new Set<string>();
    for (const fname of Object.keys(files)) {
      const m = fname.match(BUNDLE_NS_RE);
      if (m) folderSet.add(m[1]);
    }
    const folderList = [...folderSet].sort();

    // Replace: this pack's screen is mounted in place of whatever was the
    // screen, which is parked (kept, unmounted) until it comes back.
    const nextLayout = interfaceMode === "replace"
      ? {
          screen: folder,
          parked: [...(layout.parked ?? []), ...(layout.screen ? [layout.screen] : [])],
        }
      : layout;
    if (interfaceMode === "replace") previousRoot = layout.screen ? { screen: layout.screen } : {};

    // Regenerate the composed index.tsx. entryFile stays "index.tsx".
    files["index.tsx"] = generateComposedIndex(folderList, nextLayout);

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
  const settings = remapSettings(bundle.settings, remapVarId);
  const assetMap = options.assetMap && Object.keys(options.assetMap).length > 0 ? options.assetMap : undefined;
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
    ...(typeof bundle.version === "number" ? { version: bundle.version } : {}),
    ...(settings ? { settings } : {}),
    ...(assetMap ? { assetMap } : {}),
    ...(previousRoot ? { previousRoot } : {}),
    ...(intoBook ? { worldbookId: intoBook } : {}),
    sourceIds: Object.fromEntries([
      ...[...entryIdMap].map(([packId, id]) => [id, packId] as const),
      ...[...reactionIdMap].map(([packId, id]) => [id, packId] as const),
      ...[...ruleIdMap].map(([packId, id]) => [id, packId] as const),
      ...[...varIdMap].filter(([, id]) => newVars.some((v) => v.id === id)).map(([packId, id]) => [id, packId] as const),
    ]),
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
  return draft;
}

/** The card's composed index regenerated after its pack folders changed,
 *  keeping the screen it mounts. A pack that was the screen and is gone
 *  hands the screen back to the one it replaced (or to the author's root). */
function recomposeIndex(
  files: Record<string, string>,
  previousIndex: string | undefined,
  removed?: { slug?: string; previousRoot?: InstalledBundle["previousRoot"] },
): string {
  const folderSet = new Set<string>();
  for (const fname of Object.keys(files)) {
    const m = fname.match(BUNDLE_NS_RE);
    if (m) folderSet.add(m[1]);
  }
  const layout = readComposedLayout(previousIndex);
  let screen = layout.screen;
  let parked = (layout.parked ?? []).filter((f) => f !== removed?.slug);
  if (removed?.slug && screen === removed.slug) {
    screen = removed.previousRoot?.screen && folderSet.has(removed.previousRoot.screen) ? removed.previousRoot.screen : undefined;
    parked = parked.filter((f) => f !== screen);
  }
  return generateComposedIndex([...folderSet].sort(), { ...(screen ? { screen } : {}), ...(parked.length ? { parked } : {}) });
}

/** Take an installed pack out of a world: the pure half of
 *  `removeInstalledBundle` (and the first half of an update). The screen it
 *  replaced, if any, is put back. */
export function removeBundleFromWorld(world: WorldDefinition, installId: string): WorldDefinition {
  const record = (world.installedBundles ?? []).find((b) => b.installId === installId);
  if (!record) return world;

  const entryIds = new Set(record.entryIds);
  const variableIds = new Set(record.variableIds);
  const ruleIds = new Set(record.ruleIds);
  const reactionIds = new Set(record.reactionIds ?? []);
  const audioIds = new Set(record.audioTrackIds);
  const folderIds = new Set(record.folderIds);
  const worldbookIds = new Set(record.worldbookIds ?? []);

  // Drop the bundle's UI files (if any) and regenerate the composed index.
  let rootComponent = world.rootComponent;
  if (record.slug && rootComponent) {
    const prefix = `_bundles/${record.slug}/`;
    const files: Record<string, string> = {};
    for (const [path, code] of Object.entries(rootComponent.files)) {
      if (!path.startsWith(prefix)) files[path] = code;
    }
    files["index.tsx"] = recomposeIndex(files, rootComponent.files["index.tsx"], record);
    rootComponent = { ...rootComponent, files, updatedAt: new Date().toISOString() };
    if (world.uiDoc) rootComponent = compileEditorUiDoc(world.uiDoc, rootComponent);
  }

  return {
    ...world,
    entries: world.entries.filter((e) => e.bundleInstallId !== installId && !entryIds.has(e.id)),
    variables: world.variables.filter((v) => !variableIds.has(v.id)),
    rules: world.rules.filter((r) => !ruleIds.has(r.id)),
    reactions: world.reactions?.filter((r) => !reactionIds.has(r.id)),
    audioTracks: (world.audioTracks ?? []).filter((t) => !audioIds.has(t.id)),
    entryFolders: (world.entryFolders ?? []).filter((f) => !folderIds.has(f.id)),
    worldbooks: (world.worldbooks ?? []).filter((w) => !worldbookIds.has(w.id)),
    rootComponent,
    installedBundles: (world.installedBundles ?? []).filter((b) => b.installId !== installId),
  };
}

/** One of the installer's own changes to a pack's object, found by an update. */
export interface BundleUpdateEdit {
  /** The object's id in the pack (stable across versions). */
  packId: string;
  kind: "entry" | "variable" | "behavior";
  name: string;
  /** The new version changed this object too, so keeping the installer's
   *  edit means not getting the author's change to it. */
  alsoChangedUpstream: boolean;
  /** The new version no longer has this object. */
  removedUpstream: boolean;
}

export interface BundleUpdateReport {
  edits: BundleUpdateEdit[];
  /** The installer edited the pack's interface files; the new version's
   *  interface replaces them (code is not merged). */
  interfaceEdited: boolean;
  added: string[];
  changed: string[];
  removed: string[];
}

const stripIds = (value: unknown) => JSON.stringify(value, (key, v) => (key === "id" || key === "priority" || key === "position" || key === "bundleInstallId" || key === "folderId" || key === "worldbookId" ? undefined : v));
const entryShape = (e: WorldEntry) => stripIds({ name: e.name, content: e.content, role: e.role, enabled: e.enabled !== false, keywords: e.keywords ?? [], secondaryKeywords: e.secondaryKeywords ?? [], conditions: e.conditions ?? [], section: e.section, depth: e.depth ?? null, tags: e.tags ?? [] });
const variableShape = (v: Variable) => stripIds({ name: v.name, type: v.type, defaultValue: v.defaultValue, min: v.min ?? null, max: v.max ?? null, description: v.description ?? "", behaviorRules: v.behaviorRules ?? v.updateHints ?? "" });
const reactionShape = (r: Reaction) => stripIds({ name: r.name, enabled: r.enabled !== false, when: r.when, conditions: r.conditions, conditionLogic: r.conditionLogic, then: r.then });

/**
 * Move an installed pack to a newer version of itself, keeping what the
 * installer made of it.
 *
 * The old install comes out and the new version goes in under the same
 * install id, colour, situation and screen choice. Then, object by object,
 * whatever the installer had edited away from the version they installed is
 * put back over the new version's copy, unless they chose the author's
 * (`takeUpstream`). Values written by the pack's settings form are always
 * kept. An edited object the new version dropped stays in the card as the
 * installer's own. Without the old version (`previous` null) nothing can be
 * told apart, so only the settings values carry over.
 */
export function updateBundleInWorld(
  world: WorldDefinition,
  installId: string,
  next: YuminaBundle,
  previous: YuminaBundle | null,
  options: { assetMap?: Record<string, string>; takeUpstream?: ReadonlySet<string>; dryRun?: boolean } = {},
): { world: WorldDefinition; report: BundleUpdateReport } {
  const record = (world.installedBundles ?? []).find((b) => b.installId === installId);
  const report: BundleUpdateReport = { edits: [], interfaceEdited: false, added: [], changed: [], removed: [] };
  if (!record) return { world, report };

  // What the author changed between the two versions, by pack id.
  const byId = <T extends { id: string }>(list: readonly T[] | undefined) => new Map((list ?? []).map((x) => [x.id, x]));
  const prevEntries = byId(previous?.entries), nextEntries = byId(next.entries);
  const prevVars = byId(previous?.variables), nextVars = byId(next.variables);
  const prevReactions = byId(previous?.reactions), nextReactions = byId(next.reactions);
  if (previous) {
    const diff = <T extends { id: string; name?: string }>(a: Map<string, T>, b: Map<string, T>, shape: (x: T) => string) => {
      for (const [id, item] of b) {
        const old = a.get(id);
        if (!old) report.added.push(item.name ?? id);
        else if (shape(old) !== shape(item)) report.changed.push(item.name ?? id);
      }
      for (const [id, item] of a) if (!b.has(id)) report.removed.push(item.name ?? id);
    };
    diff(prevEntries, nextEntries, entryShape);
    diff(prevVars, nextVars, variableShape);
    diff(prevReactions, nextReactions, reactionShape);
  }

  // What the installer changed, by pack id (only knowable with `previous`).
  const sourceIds = record.sourceIds ?? {};
  const packIdOf = (installedId: string, name: string | undefined, pool: Map<string, { id: string; name?: string }>) =>
    sourceIds[installedId] ?? [...pool.values()].find((x) => x.name === name)?.id;
  const keptEntries = new Map<string, WorldEntry>();
  const keptVariables = new Map<string, Variable>();
  const keptReactions = new Map<string, Reaction>();
  if (previous) {
    for (const id of record.entryIds) {
      const mine = world.entries.find((e) => e.id === id);
      if (!mine) continue;
      const packId = packIdOf(id, mine.name, prevEntries);
      const original = packId ? prevEntries.get(packId) : undefined;
      if (!packId || !original || entryShape(mine) === entryShape(original)) continue;
      const upstream = nextEntries.get(packId);
      report.edits.push({ packId, kind: "entry", name: mine.name, alsoChangedUpstream: !!upstream && entryShape(upstream) !== entryShape(original), removedUpstream: !upstream });
      keptEntries.set(packId, mine);
    }
    for (const id of record.variableIds) {
      const mine = world.variables.find((v) => v.id === id);
      if (!mine) continue;
      const packId = packIdOf(id, mine.name, prevVars);
      const original = packId ? prevVars.get(packId) : undefined;
      if (!packId || !original || variableShape(mine) === variableShape(original)) continue;
      const upstream = nextVars.get(packId);
      report.edits.push({ packId, kind: "variable", name: mine.name, alsoChangedUpstream: !!upstream && variableShape(upstream) !== variableShape(original), removedUpstream: !upstream });
      keptVariables.set(packId, mine);
    }
    for (const id of record.reactionIds ?? []) {
      const mine = (world.reactions ?? []).find((r) => r.id === id);
      if (!mine) continue;
      const packId = packIdOf(id, mine.name, prevReactions);
      const original = packId ? prevReactions.get(packId) : undefined;
      if (!packId || !original || reactionShape(mine) === reactionShape(original)) continue;
      const upstream = nextReactions.get(packId);
      report.edits.push({ packId, kind: "behavior", name: mine.name, alsoChangedUpstream: !!upstream && reactionShape(upstream) !== reactionShape(original), removedUpstream: !upstream });
      keptReactions.set(packId, mine);
    }
    if (record.slug && previous.rootComponent) {
      const installed = bundleFilesFor(record.slug, world.rootComponent?.files ?? {});
      const entry = previous.rootComponent.entryFile ?? "index.tsx";
      const original: Record<string, string> = {};
      for (const [name, code] of Object.entries(previous.rootComponent.files ?? {})) {
        original[name === entry ? "index.tsx" : name === "index.tsx" ? "__aux-index.tsx" : name] = code;
      }
      report.interfaceEdited = Object.keys(installed).length !== Object.keys(original).length
        || Object.entries(installed).some(([name, code]) => original[name] !== code);
    }
  }
  if (options.dryRun) return { world, report };

  // Settings values live in variable defaults: carry them whatever the author did.
  const settingValues = new Map<string, unknown>();
  for (const field of record.settings ?? []) {
    const v = world.variables.find((x) => x.id === field.variableId);
    const packId = v ? packIdOf(v.id, v.name, prevVars.size ? prevVars : nextVars) : undefined;
    if (v && packId) settingValues.set(packId, v.defaultValue);
  }

  const take = options.takeUpstream ?? new Set<string>();
  let out = removeBundleFromWorld(world, installId);
  out = mergeBundleIntoWorld(out, next, record.sourceBundleId, {
    installId,
    colorKey: record.colorKey,
    ...(record.worldbookId ? { worldbookId: record.worldbookId } : {}),
    interface: record.previousRoot ? "replace" : record.slug ? "compose" : "skip",
    ...(options.assetMap ? { assetMap: options.assetMap } : {}),
  });
  const fresh = (out.installedBundles ?? []).find((b) => b.installId === installId);
  if (!fresh) return { world: out, report };
  const installedIdOf = (packId: string) => Object.entries(fresh.sourceIds ?? {}).find(([, p]) => p === packId)?.[0];

  // Put the installer's edits back over the new version's copies.
  const entries = [...out.entries];
  for (const [packId, mine] of keptEntries) {
    if (take.has(packId)) continue;
    const id = installedIdOf(packId);
    const at = id ? entries.findIndex((e) => e.id === id) : -1;
    if (at >= 0) entries[at] = { ...mine, id: entries[at]!.id, bundleInstallId: installId };
    else entries.push({ ...mine, bundleInstallId: undefined });
  }
  const variables = out.variables.map((v) => {
    const packId = fresh.sourceIds?.[v.id];
    if (!packId) return v;
    const mine = keptVariables.get(packId);
    if (mine && !take.has(packId)) return { ...mine, id: v.id };
    if (settingValues.has(packId)) return { ...v, defaultValue: settingValues.get(packId) as Variable["defaultValue"] };
    return v;
  });
  for (const [packId, mine] of keptVariables) {
    if (!take.has(packId) && !installedIdOf(packId) && !variables.some((v) => v.id === mine.id)) variables.push(mine);
  }
  let reactions = out.reactions ? [...out.reactions] : out.reactions;
  for (const [packId, mine] of keptReactions) {
    if (take.has(packId)) continue;
    const id = installedIdOf(packId);
    reactions = reactions ?? [];
    const at = id ? reactions.findIndex((r) => r.id === id) : -1;
    if (at >= 0) reactions[at] = { ...mine, id: reactions[at]!.id };
    else reactions.push(mine);
  }
  return { world: { ...out, entries, variables, reactions }, report };
}

export function createEmptyWorld(): WorldDefinition {
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
  /** What this person may do with the open card: its creator ("owner"), or
   *  someone the creator invited ("editor" / "viewer"). Null for a new card. */
  access: { role: "owner" | "editor" | "viewer"; canPublish: boolean } | null;
  setAccess: (access: { role: "owner" | "editor" | "viewer"; canPublish: boolean } | null) => void;
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
  /** "removed": the card was shared with this person and no longer is. */
  loadError: "notFound" | "failed" | "removed" | null;

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
  /**
   * Take back what one assistant turn did and nothing else: `before` is the
   * card before the turn, `end` the card as the turn left it, and the draft
   * is whatever the author has made of it since. One undo step, so Ctrl+Z
   * brings the turn back. `kept` counts what the turn changed that the author
   * has changed since — left as the author has it (see engine revertTurn).
   */
  revertAssistantTurn: (before: WorldDefinition, end: WorldDefinition) => { reverted: boolean; kept: number };

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
  refreshWorldSchema: (force?: boolean, options?: { source: "cover-upload"; target?: "portrait" | "landscape" } | { source: "remote-save" }) => Promise<void>;
  /**
   * Another tab, device or person saved this world (the live stream's
   * "saved" event). Applies their change set on top of what this editor has,
   * keeping its unsaved edits, or pulls and merges the server copy.
   */
  applyRemoteSave: (event: RemoteSaveEvent) => void;
  /** A text field's shared text (features/collab/live-text) written into the
   *  draft: `key` is an engine textFieldKey; "remote" when someone else typed
   *  it. Kept out of the undo history. */
  applyLiveText: (key: string, value: string, origin: "local" | "remote") => void;
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
  /** Returns the new folder's id, so a caller can file entries into it in the same step. */
  addFolder: (section: NonNullable<WorldEntry["section"]>, name?: string, worldbookId?: string) => string;
  removeFolder: (folderId: string) => void;
  renameFolder: (folderId: string, name: string) => void;
  moveFolder: (folderId: string, newSection: NonNullable<WorldEntry["section"]>) => void;
  /** Put a folder right before or after another folder of the same section. */
  reorderFolder: (folderId: string, targetFolderId: string, place: "before" | "after") => void;

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
  /** Put the interface back as it was before a run of 「换界面」 previews: the
   *  document and the compiled screen from then, without the variables the
   *  previews made. One commit, so the way back is itself one undo step. */
  restoreInterface: (
    snapshot: Pick<WorldDefinition, "uiDoc" | "rootComponent">,
    dropVariableIds: readonly string[],
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
    /** `ephemeral`: a card only looked at (a pack preview), never saved: the
     *  page's crash-recovery copy of the real draft is left alone. */
    options?: { preserveServerState?: boolean; ephemeral?: boolean }
  ) => void;
  /**
   * Upload `blob` as the current world's cover. Used after importing a PNG
   * character card (the PNG visual is the card's cover). Saves the world
   * first if it has no server id yet, since the thumbnail endpoint needs an
   * owned world. Updates `avatar` for immediate display.
   */
  applyImportedCover: (blob: Blob) => Promise<void>;
  importBundle: (bundle: YuminaBundle, sourceBundleId?: string, options?: MergeBundleOptions) => string | undefined;
  /** Keep a pack's content as the author's own: drop its install record and
   *  the tags that tie its entries to it. Nothing in the card changes. */
  detachInstalledBundle: (installId: string) => void;
  /** One settings field of an installed pack written: the variable's
   *  defaultValue at `path`. Several writes from one action are one undo. */
  setBundleSettingValues: (writes: Array<{ variableId: string; path?: string; value: unknown }>) => void;
  /** Remove a previously-imported bundle and all the content it added. */
  removeInstalledBundle: (installId: string) => void;
  /** Move an installed pack to a newer version, keeping the installer's edits (see updateBundleInWorld). One undo step. */
  updateInstalledBundle: (installId: string, next: YuminaBundle, previous: YuminaBundle | null, options?: { assetMap?: Record<string, string>; takeUpstream?: ReadonlySet<string> }) => BundleUpdateReport | null;
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
let serverAutosaveTimer: ReturnType<typeof setTimeout> | null = null;
/** When the oldest unsaved edit was made — bounds the debounce (max wait). */
let serverAutosaveDirtySince: number | null = null;
let serverAutosaveFailures = 0;
/** Size of the last save body; large cards autosave on a slower cadence. */
let lastSaveBytes = 0;
/** This tab, as the live stream names it: a save's echo comes back with it. */
export const editorClientId: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
/** The rootComponent the server holds as of the last change-set save — with
 *  the compiled output the draft never carries — so the next save sends only
 *  what moved. Reset whenever the base is replaced wholesale. */
let lastSentRoot: { epoch: number; token: string | null; root: unknown } | null = null;
/**
 * The _baseSchema object known to equal the server's stored copy exactly.
 * A card is loaded (and refreshed) through migration, which fills in
 * defaults the stored copy may not have; a change set computed against that
 * would land on a server copy missing the very rows or files it edits. So the
 * first save after any load or refresh sends the whole world, and change sets
 * only follow from a base the server provably holds. Compared by identity:
 * replacing _baseSchema any other way drops back to a whole save.
 */
let serverSyncedBase: WorldDefinition | null = null;
/** Other people's saves that arrived while a save of ours was out. */
let remoteQueue: RemoteSaveEvent[] = [];
/** Tests only: drop saves a previous test queued, so they are not replayed into the next one. */
export function __clearRemoteSaveQueueForTests(): void {
  remoteQueue = [];
}

export interface RemoteSaveEvent {
  updatedAt: string;
  previousUpdatedAt: string | null;
  clientId: string | null;
  actorUserId?: string;
  changes?: unknown[];
  /** Card fields kept beside the schema that the save set. */
  meta?: Record<string, unknown>;
}

/**
 * Card fields kept beside the schema (tags, gallery, notice…), as the server
 * last held them for this card. A change-set save sends only the ones that
 * differ from it, so one person's autosave never puts back another's old
 * tags; someone else's save replaces the ones not edited here since.
 */
const CARD_META_KEYS = ["tags", "galleryImages", "announcement", "approxTime", "variantLabel", "language"] as const;
type CardMetaKey = (typeof CARD_META_KEYS)[number];
type CardMeta = Record<CardMetaKey, unknown>;
let serverMeta: { worldId: string; meta: CardMeta } | null = null;

type CardMetaFields = Pick<EditorState, "tags" | "galleryImages" | "announcement" | "approxTime" | "variantLabel" | "language">;

/** The fields as a save sends them. */
function cardMetaOf(s: CardMetaFields): CardMeta {
  return {
    tags: s.tags, galleryImages: s.galleryImages,
    announcement: s.announcement || null, approxTime: s.approxTime || null,
    variantLabel: s.variantLabel || null, language: s.language || null,
  };
}

function cardMetaFromData(data: Record<string, unknown>): CardMeta {
  return cardMetaOf({
    tags: Array.isArray(data.tags) ? data.tags : [],
    galleryImages: Array.isArray(data.galleryImages) ? data.galleryImages : [],
    announcement: (data.announcement as string | null) ?? "",
    approxTime: (data.approxTime as string | null) ?? "",
    variantLabel: (data.variantLabel as string | null) ?? null,
    language: (data.language as string | null) ?? null,
  });
}

function knownServerMeta(worldId: string | null): CardMeta | null {
  return serverMeta && worldId && serverMeta.worldId === worldId ? serverMeta.meta : null;
}

/** Store updates for card fields someone else saved, leaving any this editor
 *  changed and has not saved yet: those go out with its next save. */
function adoptRemoteMeta(s: EditorState, remote: Partial<CardMeta>): Partial<EditorState> {
  if (!s.serverWorldId) return {};
  const known = knownServerMeta(s.serverWorldId);
  const local = cardMetaOf(s);
  const next: CardMeta = { ...(known ?? local) };
  const out: Partial<EditorState> = {};
  for (const key of CARD_META_KEYS) {
    if (!(key in remote)) continue;
    const value = remote[key];
    next[key] = value;
    if (known && !deepEqual(local[key], known[key])) continue;
    if (key === "tags" || key === "galleryImages") out[key] = Array.isArray(value) ? (value as string[]) : [];
    else if (key === "announcement" || key === "approxTime") out[key] = typeof value === "string" ? value : "";
    else out[key] = typeof value === "string" ? value : null;
  }
  serverMeta = { worldId: s.serverWorldId, meta: next };
  return out;
}

const tokenTime = (token: string | null | undefined) => (token ? Date.parse(token) : NaN);
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

/**
 * Arm the server autosave after an edit: it runs once the creator pauses
 * (debounced), but no later than the max wait after the oldest unsaved edit.
 * Safe to call on every edit.
 */
function startServerAutosave({ layoutOnly = false, text }: { layoutOnly?: boolean; text?: "local" | "remote" } = {}) {
  if (persistenceDetached || saveBlockedByReview) return;
  const now = Date.now();
  const large = lastSaveBytes > LARGE_SAVE_BYTES;
  // Someone else's typing: their own save carries it. Wait long enough for
  // that to arrive, and don't move up a save already due.
  if (text === "remote") {
    if (serverAutosaveTimer) return;
    armServerAutosave(SERVER_AUTOSAVE_REMOTE_TEXT_QUIET_MS);
    return;
  }
  serverAutosaveDirtySince ??= now;
  const together = !layoutOnly && !text && !large && collaboratorsPresent();
  const quiet = layoutOnly ? SERVER_AUTOSAVE_LAYOUT_QUIET_MS : large ? SERVER_AUTOSAVE_LARGE_QUIET_MS : together ? SERVER_AUTOSAVE_COLLAB_QUIET_MS : SERVER_AUTOSAVE_QUIET_MS;
  const maxWait = large ? SERVER_AUTOSAVE_LARGE_MAX_WAIT_MS : together ? SERVER_AUTOSAVE_COLLAB_MAX_WAIT_MS : SERVER_AUTOSAVE_MAX_WAIT_MS;
  // After failures, wait out the backoff instead of hammering a server that
  // just said no (or a connection that is down).
  const backoff = serverAutosaveFailures > 0
    ? Math.min(SERVER_AUTOSAVE_MAX_RETRY_MS, 5000 * 2 ** (serverAutosaveFailures - 1))
    : 0;
  const due = Math.max(now + backoff, Math.min(now + quiet, serverAutosaveDirtySince + maxWait));
  armServerAutosave(due - now);
}

function measureWorldSize(draft: WorldDefinition) {
  lastSaveBytes = 0;
  const schedule = typeof requestIdleCallback === "function" ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 500);
  schedule(() => {
    try { lastSaveBytes = JSON.stringify(draft).length; } catch { /* keep the fast cadence */ }
  });
}

/** Set while read-only came from opening a card as its viewer (not from the
 *  admin inspect route), so the next card gives it back. */
let readOnlyFromViewer = false;
/** A viewer reads the card; nothing they touch is saved. */
function readOnlyForAccess(access: { role?: string } | null | undefined, current: boolean): boolean {
  if (access?.role === "viewer") { readOnlyFromViewer = true; return true; }
  if (readOnlyFromViewer) { readOnlyFromViewer = false; return false; }
  return current;
}

/**
 * Replay saves in the server's order (each one's previousUpdatedAt is the
 * token before it), starting from `base` at `token`. Returns the resulting
 * copy and token, plus the other people's changes, or null when a link is
 * missing or a save came without its change set.
 */
function chainSaves(
  base: WorldDefinition,
  token: string,
  queued: RemoteSaveEvent[],
  mine: { updatedAt: string; previousUpdatedAt: string; changes: WorldEdit[] },
): { base: WorldDefinition; token: string; theirs: WorldEdit[] } | null {
  const steps = [
    ...queued.map((e) => ({ updatedAt: e.updatedAt, previousUpdatedAt: e.previousUpdatedAt, changes: e.changes, mine: false })),
    { ...mine, mine: true },
  ].sort((a, b) => tokenTime(a.updatedAt) - tokenTime(b.updatedAt));
  let current = base;
  let at = token;
  const theirs: WorldEdit[] = [];
  for (const step of steps) {
    if (tokenTime(step.updatedAt) <= tokenTime(at)) continue; // already in the base
    if (!step.previousUpdatedAt || tokenTime(step.previousUpdatedAt) !== tokenTime(at)) return null;
    if (!Array.isArray(step.changes) || !isWorldChangeList(step.changes)) return null;
    current = applyWorldChanges(current, step.changes);
    at = step.updatedAt;
    if (!step.mine) theirs.push(...step.changes);
  }
  return { base: current, token: at, theirs };
}

/** Collections whose rows people edit one at a time (an entry, a variable…). */
const EDIT_TRACKED_ROWS = ["entries", "variables", "rules", "reactions", "worldbooks", "customUI", "audioTracks", "sceneImages", "backgrounds", "scenes", "characters"] as const;

export interface EditTarget { target: string; label: string }

/** The row this edit changed, by reference (unchanged rows keep theirs). */
function editedRow(prev: WorldDefinition, next: WorldDefinition): EditTarget | null {
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  for (const key of EDIT_TRACKED_ROWS) {
    const before = a[key];
    const after = b[key];
    if (before === after || !Array.isArray(after)) continue;
    const old = new Map((Array.isArray(before) ? before : []).map((r) => [(r as { id?: unknown })?.id, r]));
    for (const row of after as Array<Record<string, unknown>>) {
      if (!row || typeof row.id !== "string") continue;
      if (old.get(row.id) === row) continue;
      const label = typeof row.name === "string" && row.name ? row.name : typeof row.title === "string" && row.title ? row.title : row.id;
      return { target: `${key}:${row.id}`, label };
    }
  }
  return null;
}

/**
 * Tell the collaboration layer what this person just edited, so others see
 * "X is editing Y" and both sides get a heads-up when they touch the same
 * thing. A DOM event keeps the store free of collaboration code.
 */
function announceLocalEdit(prev: WorldDefinition, next: WorldDefinition) {
  if (typeof window === "undefined") return;
  const edited = editedRow(prev, next);
  if (edited) window.dispatchEvent(new window.CustomEvent<EditTarget>("yumina:local-edit", { detail: edited }));
}

/** The rows a change set from someone else touched. */
function announceRemoteEdit(actorUserId: string | undefined, changes: WorldEdit[]) {
  if (typeof window === "undefined" || !actorUserId) return;
  const targets = changes
    .filter((c): c is Extract<WorldEdit, { key: string; id: string }> => c.op === "row" || c.op === "rowFields" || c.op === "delete")
    .map((c) => `${c.key}:${c.id}`);
  if (targets.length > 0) window.dispatchEvent(new window.CustomEvent("yumina:remote-edit", { detail: { actorUserId, targets } }));
}

/**
 * The undo history carried through a new server copy: what changed between
 * the old copy and the new one lands in every step, so undo steps back
 * through this editor's own edits without reverting what arrived.
 */
function historyThrough(
  s: Pick<EditorState, "_past" | "_future">,
  oldBase: WorldDefinition | null,
  newBase: WorldDefinition,
): Pick<EditorState, "_past" | "_future" | "canUndo" | "canRedo"> {
  if (!oldBase || (s._past.length === 0 && s._future.length === 0)) return { _past: [], _future: [], canUndo: false, canRedo: false };
  const theirs = diffWorld(oldBase, newBase);
  const _past = s._past.map((w) => applyWorldChanges(w, theirs));
  const _future = s._future.map((w) => applyWorldChanges(w, theirs));
  return { _past, _future, canUndo: _past.length > 0, canRedo: _future.length > 0 };
}

/** Rows someone deleted while this editor had unsaved edits in them: they
 *  stay (an edit beats a delete) and the creator is told. */
function announceRestoredRows(restored: Array<{ key: string; id: string }>, draft: WorldDefinition, actorUserId?: string) {
  const w = draft as unknown as Record<string, unknown>;
  for (const { key, id } of restored.slice(0, 3)) {
    const row = Array.isArray(w[key]) ? (w[key] as Array<Record<string, unknown>>).find((r) => r?.id === id) : undefined;
    const label = typeof row?.name === "string" && row.name ? row.name : typeof row?.title === "string" && row.title ? row.title : id;
    feedback.notice(tr("editor:collab.liveRestoredDeleted", "Someone deleted “{{label}}” while you were editing it — your edits were kept", { label }));
  }
  if (typeof window !== "undefined" && actorUserId) {
    window.dispatchEvent(new window.CustomEvent("yumina:remote-edit", { detail: { actorUserId, targets: restored.map((r) => `${r.key}:${r.id}`) } }));
  }
}

/**
 * A change-set save the server refused because someone else changed the same
 * thing (or deleted what it edited). The merge kept this editor's version;
 * say what clashed, and offer theirs back for the edited ones.
 */
function announceSaveClash(
  clash: { missing?: Array<{ key: string; id: string }>; conflicts?: Array<{ key: string; id: string; fields?: string[] }> },
  merged: WorldMergeConflict[],
  draft: WorldDefinition,
  theirs: WorldDefinition,
) {
  const label = (world: WorldDefinition, key: string, id: string) => {
    const rows = (world as unknown as Record<string, unknown>)[key];
    const row = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>).find((r) => r?.id === id) : undefined;
    return typeof row?.name === "string" && row.name ? row.name : typeof row?.title === "string" && row.title ? row.title : id;
  };
  for (const m of (clash.missing ?? []).slice(0, 2)) {
    feedback.notice(tr("editor:collab.liveRestoredDeleted", "Someone deleted “{{label}}” while you were editing it — your edits were kept", { label: label(draft, m.key, m.id) }));
  }
  const edited = (clash.conflicts ?? []).slice(0, 5);
  if (edited.length === 0) return;
  const names = edited.map((c) => (c.key === "field" || c.key === "rootComponent" ? c.id.split(".")[0]! : c.key === "rootComponent.files" ? c.id : label(draft, c.key, c.id)));
  feedback.persistent(
    tr("editor:collab.liveKeptYours", "{{names}} was also changed by someone else just now — your version was kept", { names: [...new Set(names)].join(", ") }),
    {
      label: tr("editor:collab.liveUseTheirs", "Use theirs"),
      onClick: () => takeTheirs(edited, merged, theirs),
    },
    { id: "editor-save-clash" },
  );
}

/** Put the other side's version of what clashed back in the draft. */
function takeTheirs(clashes: Array<{ key: string; id: string; fields?: string[] }>, merged: WorldMergeConflict[], theirs: WorldDefinition) {
  const s = useEditorStore.getState();
  let w = s.worldDraft as unknown as Record<string, unknown>;
  const t = theirs as unknown as Record<string, unknown>;
  for (const c of clashes) {
    if (c.key === "field") {
      const top = c.id.split(".")[0]!;
      w = { ...w, [top]: structuredClone(t[top]) };
    } else if (c.key === "rootComponent.files") {
      const files = { ...((w.rootComponent as { files?: Record<string, string> } | undefined)?.files ?? {}) };
      const theirFiles = (t.rootComponent as { files?: Record<string, string> } | undefined)?.files ?? {};
      if (c.id in theirFiles) files[c.id] = theirFiles[c.id]!; else delete files[c.id];
      w = { ...w, rootComponent: { ...(w.rootComponent as Record<string, unknown>), files } };
    } else if (c.key === "rootComponent") {
      w = { ...w, rootComponent: { ...(w.rootComponent as Record<string, unknown>), [c.id]: (t.rootComponent as Record<string, unknown> | undefined)?.[c.id] } };
    } else if (Array.isArray(w[c.key])) {
      const theirRow = Array.isArray(t[c.key]) ? (t[c.key] as Array<Record<string, unknown>>).find((r) => r?.id === c.id) : undefined;
      if (!theirRow) continue;
      w = { ...w, [c.key]: (w[c.key] as Array<Record<string, unknown>>).map((r) => {
        if (r?.id !== c.id) return r;
        if (!c.fields?.length) return structuredClone(theirRow);
        const next = { ...r };
        for (const f of c.fields) { if (theirRow[f] === undefined) delete next[f]; else next[f] = structuredClone(theirRow[f]); }
        return next;
      }) };
    }
  }
  void merged;
  useEditorStore.setState(commitDraft(s, w as unknown as WorldDefinition));
}

/** Whether a server autosave is waiting to run (tests). */
export function isServerAutosaveArmed(): boolean {
  return serverAutosaveTimer !== null;
}

function armServerAutosave(delay: number) {
  if (serverAutosaveTimer) clearTimeout(serverAutosaveTimer);
  serverAutosaveTimer = setTimeout(runServerAutosave, Math.max(0, delay));
}

function runServerAutosave() {
  serverAutosaveTimer = null;
  const state = useEditorStore.getState();
  if (!(state.isDirty || state.layoutDirty || remoteTextUnsaved) || !state.serverWorldId || state.readOnlyInspect || state.guestMode) {
    serverAutosaveDirtySince = null;
    return;
  }
  // A save is already running (manual, or another caller): look again once
  // it is likely done rather than queueing behind it.
  if (state.saving || state.loadingWorld) {
    armServerAutosave(1000);
    return;
  }
  const visit = autosaveVisit;
  const worldId = state.serverWorldId;
  // No confirmation: saveDraft stamps lastSavedAt and the header derives
  // its own "Saved" state from it. Autosave never mints a version.
  void state.saveDraft().then((ok) => {
    if (visit !== autosaveVisit) return;
    if (ok) {
      serverAutosaveFailures = 0;
      serverAutosaveDirtySince = null;
      captureHubEvent("studio_blueprint_saved", { world_id: worldId, trigger: "autosave" });
    } else {
      serverAutosaveFailures++;
    }
    // Edits made while the request was in flight, or a failed save, still
    // need to reach the server.
    const latest = useEditorStore.getState();
    if ((latest.isDirty || latest.layoutDirty) && latest.serverWorldId === worldId) startServerAutosave();
  });
}

/**
 * The tab is being hidden or closed: send what is waiting now instead of
 * after the autosave pause. A small change set goes as a keepalive request,
 * which the browser finishes even if the page is torn down meanwhile; the
 * local backup still covers anything that can't make it.
 */
export function saveBeforeLeaving(): void {
  const state = useEditorStore.getState();
  if (!(state.isDirty || state.layoutDirty) || !state.serverWorldId || state.readOnlyInspect || state.guestMode) return;
  if (state.saving || state.loadingWorld) return;
  if (serverAutosaveTimer) { clearTimeout(serverAutosaveTimer); serverAutosaveTimer = null; }
  leavingSave = true;
  runServerAutosave();
}

/** The next save is the one sent as the page goes away. */
let leavingSave = false;
/** Browsers cap what keepalive requests may carry: 64 KiB, across all of them. */
const KEEPALIVE_BODY_LIMIT = 48_000;

function stopServerAutosave() {
  if (serverAutosaveTimer) { clearTimeout(serverAutosaveTimer); serverAutosaveTimer = null; }
  serverAutosaveDirtySince = null;
  serverAutosaveFailures = 0;
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


/** A history snapshot with the board layout it is stepping onto taken from
 *  the draft it leaves: the layout is not part of history (setGraphLayout),
 *  so undo and redo leave frames and sticky notes as they are. */
function withLayoutOf(snapshot: WorldDefinition, current: WorldDefinition): WorldDefinition {
  if (current.graphLayout !== undefined) return { ...snapshot, graphLayout: current.graphLayout };
  if (!("graphLayout" in snapshot)) return snapshot;
  const { graphLayout: _dropped, ...rest } = snapshot;
  void _dropped;
  return rest as WorldDefinition;
}

/** Set while the live text layer writes a field's shared text into the
 *  draft: "remote" for someone else's typing, "local" for our own. */
let liveTextCommit: "local" | "remote" | null = null;
/**
 * The creator's update of this published card is in review, and this
 * collaborator may not publish: the server refuses saves (UPDATE_IN_REVIEW)
 * until it is decided. Edits stay here, unsaved; autosave waits for the next
 * edit or someone else's save instead of asking again every few seconds.
 */
let saveBlockedByReview = false;
/** The in-review notice was shown; again only after a save goes through. */
let reviewNoticeShown = false;
/** Someone else's typing is in the draft and no save has carried it yet. */
let remoteTextUnsaved = false;

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
  // Text typed together keeps its own history (each person undoes their own
  // typing, see features/collab/live-text), so it never enters the card's
  // undo stack — where undoing would take back other people's words too.
  // Viewers watch it arrive. Someone else's typing is saved by them: it
  // doesn't make this editor "unsaved", only arms a late backstop save.
  if (liveTextCommit) {
    if (s.readOnlyInspect || s.access?.role === "viewer") return { worldDraft: newDraft };
    if (liveTextCommit === "remote") {
      remoteTextUnsaved = true;
      scheduleEditPersistence(s, newDraft, { text: "remote" });
      return { worldDraft: newDraft };
    }
    scheduleEditPersistence(s, newDraft, { text: "local" });
    announceLocalEdit(s.worldDraft, newDraft);
    return { worldDraft: newDraft, isDirty: true };
  }
  // A viewer of someone's card reads it; nothing they touch changes it — not
  // even locally, where it used to mark the card unsaved and hold them at
  // the leave dialog for edits that could never be saved.
  if (s.access?.role === "viewer") {
    return {};
  }
  // Admin inspect mode: skip both the localStorage recovery scheduler and
  // the server autosave. Admin can mutate the local store to explore
  // ("what does this look like with this entry expanded?"), but nothing
  // should escape the tab.
  if (s.readOnlyInspect) {
    if (s._batchDepth > 0) {
      return { worldDraft: newDraft };
    }
    return { worldDraft: newDraft, isDirty: true };
  }
  saveBlockedByReview = false;
  scheduleEditPersistence(s, newDraft);
  announceLocalEdit(s.worldDraft, newDraft);
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
  { localDraft = true, text }: { localDraft?: boolean; text?: "local" | "remote" } = {},
) {
  if (s.guestMode || s.readOnlyInspect || persistenceDetached) return;
  if (localDraft) scheduleDraftSave(draft, s.serverWorldId);
  else if (!s.serverWorldId) scheduleNewWorldSave();
  // Every edit on a saved world re-arms the debounced server autosave. For
  // new worlds (no serverWorldId yet), the new-world save handles the initial
  // save itself.
  if (s.serverWorldId) startServerAutosave({ text });
}

/** A metadata setter's update: dirty, and persisted like any other edit. */
function metadataUpdate(s: EditorState, update: Partial<EditorState>): Partial<EditorState> {
  if (s.guestMode || s.access?.role === "viewer") return {};
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
export function buildServerDraftFromData(data: any): WorldDefinition {
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
  const draft = withHealedRowIds(migrateWorldDefinition(rawDraft));
  draft.entries = normalizePositions(draft.entries);
  // Heal dangling entry→folder refs so orphaned entries render (don't vanish).
  draft.entries = normalizeFolders(draft).world.entries;
  draft.loreUiBindings = normalizeLoreUiBindings(draft.loreUiBindings);
  return draft;
}

/**
 * A stored schema (a restore point's) read the way a load reads the live one:
 * migrated, defaults filled, positions and folders healed. Compared against
 * the editor's draft, the raw copy differs in all of that, and every such
 * difference would pass for an edit.
 */
/**
 * Rows of an id-keyed collection with a missing or repeated id, given one —
 * the same one on every editor that opens the card (it is derived from the
 * row's place), so they all agree. Without this a single bad row made every
 * save of that collection replace it whole, over anyone else's edits to it.
 */
function withHealedRowIds(draft: WorldDefinition): WorldDefinition {
  const w = draft as unknown as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const key of WORLD_ROW_COLLECTIONS) {
    if (key === "variables") continue; // normalizeVariableIds owns these
    const rows = w[key];
    if (!Array.isArray(rows)) continue;
    const seen = new Set<string>();
    let changed = false;
    const healed = rows.map((row, i) => {
      if (!row || typeof row !== "object") return row;
      const r = row as Record<string, unknown>;
      let id = typeof r.id === "string" && r.id ? r.id : `${key}-${i}`;
      for (let n = 2; seen.has(id); n++) id = `${typeof r.id === "string" && r.id ? r.id : `${key}-${i}`}~${n}`;
      seen.add(id);
      if (id === r.id) return row;
      changed = true;
      return { ...r, id };
    });
    if (changed) (out ??= { ...w })[key] = healed;
  }
  return (out ?? w) as unknown as WorldDefinition;
}

/**
 * Whether the draft built from a server copy holds that copy's rows and
 * frontend files exactly — then edits to it can be sent as change sets
 * against it. A load that had to give rows ids, or migration that rebuilt the
 * frontend, makes the first save a whole one, which writes the repair back.
 */
function matchesStoredCopy(raw: unknown, draft: WorldDefinition): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  const d = draft as unknown as Record<string, unknown>;
  for (const key of WORLD_ROW_COLLECTIONS) {
    const a = Array.isArray(r[key]) ? (r[key] as Array<{ id?: unknown }>) : [];
    const b = Array.isArray(d[key]) ? (d[key] as Array<{ id?: unknown }>) : [];
    if (a.length !== b.length || a.some((row, i) => row?.id !== b[i]?.id)) return false;
  }
  const rf = (r.rootComponent as { files?: unknown } | undefined)?.files;
  const df = (d.rootComponent as { files?: unknown } | undefined)?.files;
  return deepEqual(rf ?? null, df ?? null);
}

export function draftFromStoredSchema(schema: Record<string, unknown>, worldId: string): WorldDefinition {
  return buildServerDraftFromData({ id: worldId, name: schema.name, schema });
}

export const useEditorStore = create<EditorState>((set, get) => ({
  worldDraft: createEmptyWorld(),
  serverWorldId: null,
  serverCreatorId: null,
  access: null,
  setAccess: (access) => set((s) => ({ access, readOnlyInspect: readOnlyForAccess(access, s.readOnlyInspect) })),
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
      // The board's layout (where frames stand, the sticky notes) is kept
      // out of history on purpose — see setGraphLayout — so stepping back
      // through the card's edits must not carry an old layout with it: an
      // undo used to move frames back and drop a note written since.
      const previous = overlayLiveText(withLayoutOf(s._past[s._past.length - 1]!, s.worldDraft));
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
      const next = overlayLiveText(withLayoutOf(s._future[0]!, s.worldDraft));
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

  revertAssistantTurn: (before, end) => {
    // A field still holding typed text is the author's latest word: commit it
    // first, so it is judged as theirs instead of being left behind.
    try { flushPendingEditorFields(); } catch { /* fields are on their own */ }
    const s = get();
    if (s.guestMode) return { reverted: false, kept: 0 };
    const now = s.worldDraft;
    const { world, kept } = revertTurn(before, end, now);
    if (world === now) return { reverted: false, kept: kept.length };
    let draft = world;
    if (draft.entries !== now.entries) {
      // The merge judged entries without their positions (a sibling's arrival
      // shifts them all) and handed them back in order; number them from it.
      draft = { ...draft, entries: withPositionsFromOrder(normalizeFolders(draft).world.entries) };
    }
    // Not one edit among many but a rollback the author asked for: like
    // undo, it must reach a field they are focused in.
    set({ ...commitDraft(s, draft), _undoEpoch: s._undoEpoch + 1 });
    if (get().worldDraft.uiDoc && get().worldDraft.uiDoc !== now.uiDoc) scheduleUiDocRecompile();
    return { reverted: true, kept: kept.length };
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
      serverCreatorId: null, access: null,
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
        access: data.access && typeof data.access === "object" ? data.access : null,
        readOnlyInspect: readOnlyForAccess(data.access, get().readOnlyInspect),
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
      // The first save can already be a change set when this is exactly the
      // stored copy (a whole-world save of a multi-MB card for one edit was
      // the rule before).
      serverSyncedBase = matchesStoredCopy(data.schema, draft) ? get()._baseSchema : null;
      remoteTextUnsaved = false;
      serverMeta = { worldId: data.id, meta: cardMetaFromData(data) };
      // The saved interface was built by the compiler of its last save. Build
      // it again so the board shows what the card's document makes today; a
      // run or a publish saves the new build (see generatedInterfaceUnsaved).
      if (draft.uiDoc) scheduleUiDocRecompile();
      // The server rewrites the whole stored world on every save, so the
      // autosave cadence follows the card's size (change sets don't show it).
      measureWorldSize(draft);

      // Clear localStorage draft only after successful load — unless it is
      // the one being offered back below: a reload before clicking Recover
      // must not lose it. The next save that lands clears it.
      if (!recoveryDraft) clearStoredDraft();

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
    const coverTarget = options?.source === "cover-upload" ? options.target : undefined;
    // Someone else's save landing: merge it in without a notice per keystroke.
    const quietMerge = options?.source === "remote-save";
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
          if (coverTarget === "landscape") {
            merged.landscapeCover = draft.landscapeCover;
            merged.landscapeCoverCrop = draft.landscapeCoverCrop;
          } else {
            merged.avatar = draft.avatar;
            merged.coverCrop = draft.coverCrop;
            merged.galleryCoverCrop = draft.galleryCoverCrop;
          }
        }
        // The layout (positions, sticky notes) merged node by node and note
        // by note above, like the content.
        merged.entries = normalizeFolders(merged).world.entries;
        const nextBase = structuredClone(draft);
        set({
          ...adoptRemoteMeta(get(), cardMetaFromData(data)),
          worldDraft: overlayLiveText(merged),
          // stays dirty — merged still carries the user's unsaved edits vs server
          // Undo keeps stepping back through this editor's own edits, with
          // what arrived carried into each step (it used to be wiped).
          ...historyThrough(get(), get()._baseSchema, nextBase),
          pendingEdit,
          worldStatus,
          submittedForReviewAt,
          baseUpdatedAt: serverToken,
          _baseSchema: nextBase,
        });
        serverSyncedBase = matchesStoredCopy(data.schema, draft) ? nextBase : null;
        // Nothing failed here — the agent rewrote the draft under the creator
        // while they were looking at something else. That is news they could
        // not watch happen, so it gets the neutral notice pill, never the red
        // error one. (The STALE_WORLD save path below DID fail and keeps
        // feedback.error.)
        if ((!afterCoverUpload && !quietMerge) || conflicts.length > 0) feedback.notice(
          conflicts.length > 0
            ? tr("editor:save.agentMergedConflictsNotice", "Merged — your version kept")
            : tr("editor:save.agentMergedNotice", "Merged with agent changes"),
        );
        return;
      }

      // Content is clean, but an unsaved arrangement or note still belongs to
      // the creator. Adopt server content and merge that separate write into
      // the server's layout, so a note someone else just added stays too.
      const layoutDirty = get().layoutDirty;
      const graphLayout = layoutDirty
        ? mergeWorldValue("graphLayout", get()._baseSchema?.graphLayout, get().worldDraft.graphLayout, draft.graphLayout).value as WorldDefinition["graphLayout"]
        : undefined;
      const nextBase = structuredClone(draft);
      set({
        ...adoptRemoteMeta(get(), cardMetaFromData(data)),
        worldDraft: overlayLiveText(layoutDirty ? { ...draft, graphLayout } : draft),
        isDirty: false,
        layoutDirty,
        ...historyThrough(get(), get()._baseSchema, nextBase),
        pendingEdit,
        worldStatus,
        submittedForReviewAt,
        baseUpdatedAt: serverToken,
        _baseSchema: nextBase,
      });
      serverSyncedBase = matchesStoredCopy(data.schema, draft) ? nextBase : null;
      if (draft.uiDoc) scheduleUiDocRecompile();
    } catch {
      // Crop saving depends on this fresh baseline. Unlike a background
      // refresh, a failed upload sync must not silently use the old revision.
      if (afterCoverUpload) throw syncFailed();
      // Silent — this is a best-effort background refresh
    }
  },

  applyRemoteSave: (event) => {
    const s = get();
    if (saveBlockedByReview && (s.isDirty || s.layoutDirty)) {
      // Someone saved: the review may be over. Try once more.
      saveBlockedByReview = false;
      startServerAutosave();
    }
    if (event.clientId && event.clientId === editorClientId) return; // our own echo
    // Viewers watch the card change; admin inspect and guests don't follow it.
    if (!s.serverWorldId || s.guestMode || (s.readOnlyInspect && s.access?.role !== "viewer")) return;
    const incoming = tokenTime(event.updatedAt);
    if (!Number.isFinite(incoming)) return;
    // Already have it (a refresh or our own save got there first).
    if (Number.isFinite(tokenTime(s.baseUpdatedAt)) && incoming <= tokenTime(s.baseUpdatedAt)) return;
    // A save of ours is out: its response says whether something landed under
    // it, and the save path merges then. Never splice into a request in flight.
    if (s.saving || s.loadingWorld) {
      if (s.saving) remoteQueue.push(event);
      set({ _pendingServerRefresh: true });
      return;
    }
    if (event.meta && typeof event.meta === "object") set(adoptRemoteMeta(s, event.meta as Partial<CardMeta>));
    const changes = Array.isArray(event.changes) && isWorldChangeList(event.changes) ? event.changes : null;
    const base = s._baseSchema;
    if (changes && base && event.previousUpdatedAt && tokenTime(event.previousUpdatedAt) === tokenTime(s.baseUpdatedAt)) {
      // Their change set applies to exactly the copy we hold. Apply it to the
      // base, carry our unsaved edits over it, and run the undo history
      // through it too — so undo steps back through OUR edits without
      // reverting theirs.
      const nextBase = applyWorldChanges(base, changes);
      const dirty = s.isDirty || s.layoutDirty;
      const rebased = dirty ? rebaseWorldDetailed(base, s.worldDraft, nextBase) : null;
      const nextDraft = overlayLiveText(rebased ? rebased.world : nextBase);
      if (rebased?.restored.length) announceRestoredRows(rebased.restored, nextDraft, event.actorUserId);
      if (lastSentRoot && lastSentRoot.token === s.baseUpdatedAt) {
        const root = applyWorldChanges({ rootComponent: lastSentRoot.root } as unknown as WorldDefinition, changes) as unknown as { rootComponent?: unknown };
        lastSentRoot = { ...lastSentRoot, token: event.updatedAt, root: root.rootComponent };
      }
      if (base === serverSyncedBase) serverSyncedBase = nextBase;
      set({
        _baseSchema: nextBase,
        baseUpdatedAt: event.updatedAt,
        worldDraft: nextDraft,
        _past: s._past.map((w) => applyWorldChanges(w, changes)),
        _future: s._future.map((w) => applyWorldChanges(w, changes)),
      });
      if (changes.some((c) => (c.op === "field" && c.key === "uiDoc") || ("path" in c && c.path[0] === "uiDoc"))) scheduleUiDocRecompile();
      announceRemoteEdit(event.actorUserId, changes);
      return;
    }
    // A save we can't apply directly (an assistant or outside-AI write, a big
    // change set, or one we missed): pull the server copy and merge. The
    // event can arrive before its writer's transaction commits, so look again
    // until the copy we hold is at least that new.
    void (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 750 * attempt));
        const now = get();
        if (now.serverWorldId !== s.serverWorldId) return;
        if (Number.isFinite(tokenTime(now.baseUpdatedAt)) && tokenTime(now.baseUpdatedAt) >= incoming) return;
        if (now.saving) { set({ _pendingServerRefresh: true }); return; }
        await get().refreshWorldSchema(false, { source: "remote-save" }).catch(() => {});
      }
    })();
  },

  applyLiveText: (key, value, origin) => {
    set((s) => {
      const next = writeTextField(s.worldDraft, key, value);
      if (next === s.worldDraft) return {};
      liveTextCommit = origin;
      try {
        return commitDraft(s, next);
      } finally {
        liveTextCommit = null;
      }
    });
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
      serverCreatorId: null, access: null,
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
    // Kept by the original author: there is no page to open it on.
    if (kind === "entry" && get().worldDraft.entries.find((e) => e.id === id)?.sealed) return;
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
      // Directly under its source (halfway to the next entry), not at the end
      // of a 76-entry list — without renumbering anyone else's entries.
      const slot = positionAfter(s.worldDraft.entries, src);
      const copy: WorldEntry = {
        ...structuredClone(rest),
        id: newId,
        name: nextCopyName(src.name, s.worldDraft.entries, copySuffix),
        position: slot ?? (src.position ?? 0) + 0.5,
      };
      const entries = [...s.worldDraft.entries];
      entries.splice(index + 1, 0, copy);
      const draft = { ...s.worldDraft, entries: slot === null ? renumberSection(entries, src.section) : entries };
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
        entries: filtered,
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
        // An AI that lived in this place is in no place now. Said so — it is
        // what the runtime does with a host that is gone — rather than left
        // pointing at nothing, which its 「在哪」 menu showed as 「卡片」.
        worldbooks: (s.worldDraft.worldbooks ?? [])
          .filter((w) => w.id !== id)
          .map((w) => (w.host === id ? { ...w, host: UNPLACED_WORLDBOOK_ID } : w)),
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
      // Only the passed ids move; entries NOT listed keep their position — a
      // drag inside one filtered view (a single book, a tag filter, the
      // greeting tabs) must never renumber entries outside that view. Callers
      // pass the complete intended order for whatever slice they own.
      const newPos = slotPositions(s.worldDraft.entries, entryIds);
      const entries = s.worldDraft.entries.map((entry) => {
        const pos = newPos.get(entry.id);
        return pos === undefined || pos === entry.position ? entry : { ...entry, position: pos };
      });
      const draft = { ...s.worldDraft, entries };
      return commitDraft(s, draft);
    });
  },

  addFolder: (section, name = "New Folder", worldbookId) => {
    const id = crypto.randomUUID();
    set((s) => {
      const existingFolders = (s.worldDraft.entryFolders ?? []).filter(
        (f) => f.section === section && (f.worldbookId ?? undefined) === (worldbookId ?? undefined),
      );
      const maxOrder = existingFolders.reduce((max, f) => Math.max(max, f.order), -1);
      const newFolder: EntryFolder = {
        id,
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
    return id;
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

  reorderFolder: (folderId, targetFolderId, place) => {
    set((s) => {
      const folders = s.worldDraft.entryFolders ?? [];
      const folder = folders.find((f) => f.id === folderId);
      const target = folders.find((f) => f.id === targetFolderId);
      if (!folder || !target || folder.id === target.id || folder.section !== target.section) return s;
      // Renumber the whole section, every book included: the all-books view
      // shows them in one list, so their relative order has to survive.
      const ids = folders
        .filter((f) => f.section === folder.section && f.id !== folderId)
        .sort((a, b) => a.order - b.order)
        .map((f) => f.id);
      ids.splice(ids.indexOf(targetFolderId) + (place === "after" ? 1 : 0), 0, folderId);
      const order = new Map(ids.map((id, index) => [id, index]));
      const draft = {
        ...s.worldDraft,
        entryFolders: folders.map((f) => {
          const next = order.get(f.id);
          return next === undefined || next === f.order ? f : { ...f, order: next };
        }),
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
      if (s.serverWorldId) startServerAutosave({ layoutOnly: !s.isDirty });
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

  restoreInterface: (snapshot, dropVariableIds) =>
    set((s) => {
      if (s.readOnlyInspect || s.guestMode) return {};
      const drop = new Set(dropVariableIds);
      const nextDraft: WorldDefinition = {
        ...s.worldDraft,
        uiDoc: snapshot.uiDoc,
        rootComponent: snapshot.rootComponent,
        variables: drop.size ? s.worldDraft.variables.filter((v) => !drop.has(v.id)) : s.worldDraft.variables,
      };
      return { ...commitDraft(s, nextDraft), templateLeftovers: null };
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
      serverCreatorId: null, access: null,
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
    if (preserveServerState) keepOwnArtwork(draft, prev.worldDraft);
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
    if (options?.ephemeral) return;
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

  importBundle: (bundle, sourceBundleId, options) => {
    let installId: string | undefined;
    set((s) => {
      const draft = mergeBundleIntoWorld(s.worldDraft, bundle, sourceBundleId, options);
      installId = draft.installedBundles?.[draft.installedBundles.length - 1]?.installId;
      return commitDraft(s, draft);
    });
    return installId;
  },

  detachInstalledBundle: (installId) => {
    set((s) => {
      const records = s.worldDraft.installedBundles ?? [];
      if (!records.some((b) => b.installId === installId)) return s;
      return commitDraft(s, {
        ...s.worldDraft,
        entries: s.worldDraft.entries.map((e) => {
          if (e.bundleInstallId !== installId) return e;
          const { bundleInstallId: _tag, ...own } = e;
          return own as WorldEntry;
        }),
        worldbooks: s.worldDraft.worldbooks?.map((w) => {
          if (w.sourceBundleId !== installId) return w;
          const { sourceBundleId: _src, ...own } = w;
          return own as Worldbook;
        }),
        installedBundles: records.filter((b) => b.installId !== installId),
      });
    });
  },

  setBundleSettingValues: (writes) => {
    if (writes.length === 0) return;
    set((s) => {
      const variables = s.worldDraft.variables.map((v) => {
        const mine = writes.filter((w) => w.variableId === v.id);
        if (mine.length === 0) return v;
        let value: unknown = v.defaultValue;
        for (const w of mine) value = writeSettingValue(value, w.path, w.value);
        return { ...v, defaultValue: value as Variable["defaultValue"] };
      });
      return commitDraft(s, { ...s.worldDraft, variables });
    });
  },

  removeInstalledBundle: (installId) => {
    set((s) => {
      if (!(s.worldDraft.installedBundles ?? []).some((b) => b.installId === installId)) return s;
      return commitDraft(s, removeBundleFromWorld(s.worldDraft, installId));
    });
  },

  updateInstalledBundle: (installId, next, previous, options) => {
    let report: BundleUpdateReport | null = null;
    set((s) => {
      const result = updateBundleInWorld(s.worldDraft, installId, next, previous, options);
      report = result.report;
      return result.world === s.worldDraft ? s : commitDraft(s, result.world);
    });
    return report;
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
    // Someone else's typing in the draft goes out with this save.
    const remoteTextAtSave = remoteTextUnsaved;
    remoteTextUnsaved = false;
    let saved = false;

    try {
      // Only entries that have no position get one; positions are never
      // renumbered on save (see normalizePositions).
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
      // A card being made without a name of its own is numbered by the
      // server after the creator's other untitled ones ("Untitled World 2").
      if (!serverWorldId && isPlaceholderCardName(cleanDraft.name)) {
        payload.name = untitledCardName();
        payload.numberUntitled = true;
      }
      const errorOptions = { ...saveErrorOptions, payload };
      const validationError = worldSaveValidationMessage(payload, Boolean(serverWorldId), errorOptions);
      if (validationError) {
        showWorldSaveError(validationError);
        return false;
      }

      // Phase 3: stamp the rootComponent with pre-compiled JS so play-time can
      // skip the in-browser recompile. Cached per session by file hash; on
      // compile failure we omit `compiled` and play-time falls back to the live
      // client compile (and the server stamps it later if it can). Never blocks
      // the save. Only a real embedded file (the server's own test: 200+
      // base64 chars) skips it, so the stamp does not double that bloat; the
      // old test skipped any "data:x/" text, a 1-pixel placeholder included,
      // which left a fifth of the heavy cards compiling on every play.
      const rootForCompile = schemaWithoutAvatar.rootComponent;
      if (rootForCompile && Object.keys(rootForCompile.files ?? {}).length > 0) {
        const rcEntry = rootForCompile.entryFile || "index.tsx";
        const rcFiles = rootForCompile.files;
        const hasInlineDataUri = /data:(?:image|audio|video|font)\/[^;,]+;base64,[A-Za-z0-9+/=]{200,}/.test(JSON.stringify(rcFiles));
        if (!hasInlineDataUri) {
          const filesHash = hashRootFiles(rcEntry, rcFiles);
          let code = rootCompileCache.get(filesHash);
          if (code === undefined) {
            try {
              const { compileRootComponent } = await import("@yumina/shared/card-code");
              code = compileRootComponent(rcEntry, rcFiles)?.code ?? "";
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

      // A saved world sends what changed since the copy the server has, not
      // the whole world: small requests at autosave cadence, and the server
      // applies them on top of anyone else's saves instead of rejecting this
      // one as stale. Without a base (new world, legacy token) it still sends
      // the whole world.
      const changeBase = serverWorldId && baseUpdatedAt && started._baseSchema && started._baseSchema === serverSyncedBase
        ? started._baseSchema
        : null;
      let changeBody: string | null = null;
      let sentChanges: WorldEdit[] | null = null;
      let rootCompiled: unknown = null;
      let emptySave = false;
      let sentMeta: Record<string, unknown> = payload;
      const sentRoot = schemaWithoutAvatar.rootComponent;
      if (changeBase) {
        const { avatar: _baseAvatar, rootComponent: baseRoot, ...baseRest } = changeBase;
        const { rootComponent: _nextRoot, ...nextRest } = schemaWithoutAvatar;
        const knownRoot = lastSentRoot && lastSentRoot.epoch === documentAtSave && lastSentRoot.token === baseUpdatedAt
          ? lastSentRoot.root
          : baseRoot;
        // Text typed together is the same on every screen, so whichever save
        // lands last is right: it is never checked for conflicts, and the
        // server leaves its live copy alone. Every other edit says what it
        // started from, so the server can refuse to write over someone else's
        // change to the same thing instead of silently losing it.
        const live = liveTextKeys();
        const liveSet = new Set(live);
        const knownBase = { ...changeBase, rootComponent: knownRoot } as WorldDefinition;
        sentChanges = annotateChangeBase(knownBase, [
          ...diffWorld(baseRest as WorldDefinition, nextRest as WorldDefinition),
          ...diffWorld({ rootComponent: knownRoot } as unknown as WorldDefinition, { rootComponent: sentRoot } as unknown as WorldDefinition),
        ], (key) => liveSet.has(key));
        const { schema: _wholeSchema, ...metadata } = payload;
        // Only the card fields this editor changed: sending the rest would put
        // back whatever it last saw over someone else's newer save.
        const known = knownServerMeta(serverWorldId);
        if (known) for (const key of CARD_META_KEYS) if (deepEqual(metadata[key], known[key])) delete metadata[key];
        if (cleanDraft.name === changeBase.name) delete metadata.name;
        if (cleanDraft.description === changeBase.description) delete metadata.description;
        sentMeta = metadata;
        // The compiled frontend goes beside the change set when it changed,
        // never inside it (others are sent the change set).
        const knownCompiled = (knownRoot as { compiled?: { filesHash?: string } } | undefined)?.compiled;
        const nextCompiled = (sentRoot as { compiled?: { filesHash?: string } } | undefined)?.compiled;
        rootCompiled = nextCompiled && nextCompiled.filesHash !== knownCompiled?.filesHash ? nextCompiled : null;
        const metaKeys = Object.keys(metadata).filter((key) => key !== "baseUpdatedAt");
        if (sentChanges.length === 0 && metaKeys.length === 0 && !rootCompiled) {
          // Nothing the server doesn't already have (someone else's save
          // carried it): done, without a write.
          emptySave = true;
        }
        changeBody = JSON.stringify({ ...metadata, schemaChanges: sentChanges, clientId: editorClientId, ...(live.length ? { textSynced: live } : {}), ...(rootCompiled ? { rootCompiled } : {}) });
        // An enormous change set (a first save that rewrites a big frontend)
        // goes as a whole world, where an oversized compile cache can be dropped.
        if (changeBody.length > MAX_WORLD_SAVE_BODY_BYTES / 2) {
          changeBody = null;
          sentChanges = null;
          sentMeta = payload;
        }
      }
      // Precompiled JS is optional. If it doubles a large imported world past
      // the API body limit, save its complete source and compile on play instead.
      const saveBody = changeBody ?? serializeWorldSavePayload(payload);
      if (!changeBody) lastSaveBytes = saveBody.length;
      if (!isCurrentSession()) return false;

      if (!isCurrentCard()) return false;
      if (serverWorldId && emptySave) {
        leavingSave = false;
        if (hasNoDrift()) {
          set({ isDirty: false, layoutDirty: false, lastSavedAt: Date.now() });
          settleStoredDraftAfterSave(draftSeqAtSave, true);
        }
        saved = true;
        return true;
      }
      if (serverWorldId) {
        // The save sent as the page goes away outlives it (see
        // saveBeforeLeaving) when it is small enough for the browser to keep —
        // without the compiled frontend, which play rebuilds when it's stale.
        const leanBody = leavingSave && changeBody && rootCompiled
          ? JSON.stringify({ ...JSON.parse(changeBody), rootCompiled: undefined })
          : changeBody;
        const keepalive = leavingSave && !!leanBody && new TextEncoder().encode(leanBody).length < KEEPALIVE_BODY_LIMIT;
        const sendBody = keepalive ? leanBody! : saveBody;
        leavingSave = false;
        const send = (withKeepalive: boolean) => fetch(`${apiBase}/api/worlds/${serverWorldId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: withKeepalive ? sendBody : saveBody,
          ...(withKeepalive ? { keepalive: true } : {}),
        });
        // Other keepalive requests in flight can fill the browser's quota.
        const patch = () => (keepalive ? send(true).catch((error) => {
          if (error instanceof TypeError) return send(false);
          throw error;
        }) : send(false));
        let res = await patch();
        // Someone saved between the server's read and its lock: the change
        // set still applies, so send it again. (A 409 body read here is
        // handed to the conflict handling below.)
        let conflictBody: unknown;
        for (let attempt = 0; changeBody && res.status === 409 && attempt < 3; attempt++) {
          conflictBody = await res.json().catch(() => ({}));
          if ((conflictBody as { code?: string } | null)?.code !== "CHANGES_RETRY" || !isCurrentSession()) break;
          conflictBody = undefined;
          res = await patch();
        }
        if (!isCurrentSession()) {
          if (res.ok) useWorldsStore.getState().invalidate();
          return false;
        }
        if (res.ok) {
          useWorldsStore.getState().invalidate();
          // The server tells us whether a material change to this published
          // world was held back from the live card for re-review.
          const body = await res.json().catch(() => ({ data: {} }));
          const updated = (body as { data?: { pendingEdit?: WorldPendingEditSummary | null; heldForReview?: string[]; supersededReview?: boolean; updatedAt?: string; previousUpdatedAt?: string | null } })?.data ?? {};
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
          const savedBase = structuredClone(cleanDraft);
          set({
            _baseSchema: savedBase,
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
          // The server now holds what we sent (a whole world passed the
          // STALE guard; a change set applied to the copy we held).
          serverSyncedBase = savedBase;
          lastSentRoot = { epoch: documentAtSave, token: savedToken, root: sentRoot };
          const queued = remoteQueue;
          remoteQueue = [];
          // The server now holds the card fields this save sent; saves of
          // others that landed after it override them, earlier ones don't.
          if (currentServerId) {
            const sent: Partial<CardMeta> = {};
            for (const key of CARD_META_KEYS) if (key in sentMeta) sent[key] = sentMeta[key];
            serverMeta = { worldId: currentServerId, meta: { ...(knownServerMeta(currentServerId) ?? cardMetaOf(started)), ...sent } };
            for (const event of [...queued].sort((a, b) => tokenTime(a.updatedAt) - tokenTime(b.updatedAt))) {
              if (!event.meta || typeof event.meta !== "object") continue;
              const theirs = { ...(event.meta as Partial<CardMeta>) };
              if (savedToken && tokenTime(event.updatedAt) < tokenTime(savedToken)) for (const key of Object.keys(sent)) delete theirs[key as CardMetaKey];
              set(adoptRemoteMeta(get(), theirs));
            }
          }
          if (sentChanges) {
            const previous = validServerToken(updated.previousUpdatedAt);
            const landedOnOurs = !previous || !baseUpdatedAt || tokenTime(previous) === tokenTime(baseUpdatedAt);
            if (!landedOnOurs || queued.length > 0) {
              // Others saved around this one. Replay their change sets and
              // ours in the server's order on the copy we started from; if
              // the chain is unbroken we stay in step with the server.
              const chained = started._baseSchema && savedToken && baseUpdatedAt
                ? chainSaves(started._baseSchema, baseUpdatedAt, queued, { updatedAt: savedToken, previousUpdatedAt: previous ?? baseUpdatedAt, changes: sentChanges })
                : null;
              if (chained) {
                const now = get();
                const theirs = chained.theirs;
                set({
                  _baseSchema: chained.base,
                  baseUpdatedAt: chained.token,
                  worldDraft: overlayLiveText(applyWorldChanges(chained.base, diffWorld(cleanDraft, now.worldDraft))),
                  _past: now._past.map((w) => applyWorldChanges(w, theirs)),
                  _future: now._future.map((w) => applyWorldChanges(w, theirs)),
                  _pendingServerRefresh: false,
                });
                serverSyncedBase = chained.base;
                lastSentRoot = null;
              } else {
                // A gap that cannot be replayed: pull the server copy and merge.
                serverSyncedBase = null;
                set({ _pendingServerRefresh: true });
              }
            } else {
              set({ _pendingServerRefresh: false });
            }
          } else if (queued.length > 0) {
            serverSyncedBase = null;
            set({ _pendingServerRefresh: true });
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
          saved = true;
          reviewNoticeShown = false;
          // Saves from elsewhere that arrived while this one was out: merge
          // them in now (unsaved edits made meanwhile survive the merge).
          if (get()._pendingServerRefresh) {
            set({ _pendingServerRefresh: false });
            get().refreshWorldSchema(false, { source: "remote-save" }).catch(() => {});
          }
          return true;
        } else if (res.status === 409) {
          // Locked while in review — say why the edits are not sticking.
          const body = conflictBody !== undefined ? conflictBody : await res.json().catch(() => ({}));
          if (!isCurrentSession()) return false;
          const code = (body as { code?: string })?.code;
          if (code === "UPDATE_IN_REVIEW") {
            // Kept here, unsaved, and said once — not on every autosave.
            if (!reviewNoticeShown) {
              reviewNoticeShown = true;
              feedback.notice(tr("editor:collab.liveUpdateInReview", "The creator's update is in review — your changes will save once the review is done"));
            }
            saveBlockedByReview = true;
            if (serverAutosaveTimer) { clearTimeout(serverAutosaveTimer); serverAutosaveTimer = null; }
            return false;
          }
          if (code === "WORLD_IN_REVIEW") {
            // The server just told us authoritatively that this card is in
            // review — sync the chip so it offers "withdraw" instead of a
            // misleading "Not live"/"Publish" state.
            set({ worldStatus: "pending_review" });
            feedback.error(tr("editor:review.lockedToast", "In review — withdraw it to edit"));
            return false;
          }
          const clash = code === "CHANGES_CONFLICT" ? body as { missing?: Array<{ key: string; id: string }>; conflicts?: Array<{ key: string; id: string; fields?: string[] }> } : null;
          if (code === "STALE_WORLD" || clash) {
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
              const { merged: mergedRaw, conflicts } = mergeWorldDefinition(get()._baseSchema, get().worldDraft, serverDraft);
              const merged = overlayLiveText(mergedRaw);
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
              const mergedBase = structuredClone(serverDraft);
              set({
                ...adoptRemoteMeta(get(), cardMetaFromData(sdata)),
                worldDraft: merged,
                ...historyThrough(get(), get()._baseSchema, mergedBase),
                _baseSchema: mergedBase,
                baseUpdatedAt: validServerToken(sdata.updatedAt) ?? get().baseUpdatedAt,
                isDirty: true,
              });
              serverSyncedBase = matchesStoredCopy(sdata.schema, serverDraft) ? mergedBase : null;
              if (clash) {
                // Someone else changed what this save changed: our version is
                // kept and saved now — and the creator hears exactly what
                // clashed, with a way to take theirs instead.
                announceSaveClash(clash, conflicts, merged, serverDraft);
                if (!staleMergeRetryInFlight) {
                  staleMergeRetryInFlight = true;
                  try {
                    set({ saving: false });
                    return await get().saveDraft();
                  } finally {
                    staleMergeRetryInFlight = false;
                  }
                }
                return false;
              }
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
            // Whoever made the card owns it: with access set, sharing, the
            // live stream and presence work from its first save on.
            serverCreatorId: typeof data.creatorId === "string" ? data.creatorId : null,
            access: { role: "owner", canPublish: true },
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
          // The number the server gave an untitled card is its name now, here
          // too, and not an edit of the creator's.
          if (typeof data.name === "string" && data.name && data.name !== cleanDraft.name && isPlaceholderCardName(get().worldDraft.name)) {
            updates.worldDraft = { ...get().worldDraft, name: data.name };
            updates._baseSchema = { ...structuredClone(cleanDraft), name: data.name };
          }
          currentServerId = data.id;
          set(updates);
          settleStoredDraftAfterSave(draftSeqAtSave, noDriftDuringSave);
          useWorldsStore.getState().invalidate();
          set({ lastSavedAt: Date.now() });
          // A saved language change makes the server demote/reconcile 主/副; refresh
          // the variant bar so its stars match the server (no stale/duplicate 主).
          if (get().languageGroupId) get().loadVariants();
          // Someone else's save (a collaborator, another tab) landed around
          // ours: pull it in now, quietly — it is announced where it lands.
          if (noDriftDuringSave && get()._pendingServerRefresh) {
            set({ _pendingServerRefresh: false });
            get().refreshWorldSchema(false, { source: "remote-save" }).catch(() => {});
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
      if (!saved && remoteTextAtSave && isCurrentSession()) remoteTextUnsaved = true;
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
    if (get().serverWorldId === worldId) set({ serverWorldId: null, serverCreatorId: null, access: null, isDirty: false, layoutDirty: false });
  },

  stopAutosave: () => {
    // Called from every editor route's unmount cleanup — leaving the editor
    // makes a recovery offer meaningless, and a persistent pill must not
    // linger over Discover.
    //
    // The route's cleanup runs before its children's. A field still holding
    // typed text commits it as it unmounts, and that commit used to restart
    // the server autosave and queue a recovery write AFTER this had
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
