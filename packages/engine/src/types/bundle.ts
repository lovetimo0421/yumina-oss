import type {
  WorldEntry,
  EntryFolder,
  Variable,
  Rule,
  CustomComponent,
  CustomUIComponent,
  RootComponent,
  AudioTrack,
  Worldbook,
} from "./index.js";
import type { GameComponent } from "./components.js";
import type { Reaction } from "../events/types.js";

/**
 * One field of a pack's settings form: what a card author fills in after
 * installing (a name, a voice, a picture). The value lands in a variable's
 * defaultValue — at `path` inside it when the variable is json.
 */
export interface BundleSettingField {
  id: string;
  label: string;
  hint?: string;
  /** voice: one of the creator's own voices (我的声音), written as its fish.audio voice id.
   *  liveCharacter: one of the creator's live characters, written as "@rig:<id>". */
  type: "text" | "textarea" | "number" | "toggle" | "select" | "asset" | "voice" | "liveCharacter";
  /** The variable whose defaultValue receives the value. */
  variableId: string;
  /** Dot path inside a json variable, e.g. "voice.id". */
  path?: string;
  /** select */
  options?: { value: string; label: string }[];
  /** asset: the file input's accept list. */
  accept?: string;
  /** asset: by the uploaded file's extension, write "@asset:<id>" at `path`
   *  (default: the field's path) and set the extra values. */
  extensionRules?: { ext: string; path?: string; also?: { path: string; value: unknown }[] }[];
  /** voice / liveCharacter: other values written with a pick (e.g. body.type = "rig6" beside body.pack). */
  also?: { path: string; value: unknown }[];
}

/**
 * A shareable resource pack.
 *
 * Bundles carry content (entries, variables, rules, audio) and optionally a
 * visual layer (rootComponent — a multi-file React app). When imported into
 * an existing world, content is appended with ID remapping; the rootComponent
 * is either merged (file-by-file) or installed wholesale if the target world
 * still has the default Chat root.
 */
export interface YuminaBundle {
  /** "3.0.0" = rootComponent-native. Older values ("2.0.0" and below) are
   *  still readable via legacy field fallbacks. */
  bundleVersion: "3.0.0" | "2.0.0";
  name: string;
  description: string;
  tags: string[];
  createdAt: string;

  // ── Content ──
  entries: WorldEntry[];
  variables: Variable[];
  /** Legacy behaviors. Only populated when the source world predates `reactions`
   *  — a bundle carries its behaviors in exactly ONE of `rules`/`reactions`,
   *  never both (the runtime evaluates both arrays, so duplicating a behavior
   *  across them would fire it twice). */
  rules: Rule[];
  /** Behaviors ("行为"), the modern form. Absent on pre-reaction bundles.
   *  Edited legacy behaviors may retain a validated `_legacyTrigger` so rich
   *  keyword and crossing conditions survive saving and copying. Never include
   *  the same behavior in both arrays: the runtime would execute it twice. */
  reactions?: Reaction[];
  audioTracks: AudioTrack[];
  /** Worldbooks (lore modules) referenced by the bundle's entries. Imported
   *  with fresh ids; member entries' worldbookId + activation condition
   *  variableIds are remapped. Absent on pre-worldbook bundles (no-op). */
  worldbooks?: Worldbook[];

  /** Optional visual layer — a full multi-file React root. Present when the
   *  bundle is a template or ships UI alongside its content. Absent for pure
   *  content packs. */
  rootComponent?: RootComponent;

  /** The form a card author fills in after installing. */
  settings?: BundleSettingField[];
  /** Increases with each published update of the pack. */
  version?: number;

  // ── Organization ──
  customTags?: string[];
  entryFolders?: EntryFolder[];

  // ── Legacy (kept only to read old DB rows; never written by new bundles) ──
  /** @deprecated v19-era custom UI array. On import, converted into
   *  rootComponent.files via customUIToRootFiles(). */
  customUI?: CustomUIComponent[];
  /** @deprecated Pre-v19 game components. Ignored on import. */
  components?: GameComponent[];
  /** @deprecated Pre-v19 custom components array. Converted into rootComponent.files on import. */
  customComponents?: CustomComponent[];
  /** @deprecated Pre-v19 single message renderer. Converted into rootComponent.files on import. */
  messageRenderer?: CustomComponent;
}
