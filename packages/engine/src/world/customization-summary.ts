import type { WorldDefinition } from "../types/index.js";
import { frontendManifest, type FrontendApiFamily, type FrontendFileFacts } from "../graph/frontend-manifest.js";
import { resolveStation } from "../lorebook/station.js";

/**
 * What a card customizes, said in one object.
 *
 * The hub shows a cover, a blurb and a tag wall. Two cards with the same tags
 * can be a plain text story and a fifty-file stage with two AIs of its own,
 * and a player — or a creator deciding what to learn from — cannot tell
 * which they are opening. This is the honest version, derived from the
 * schema on demand and never stored: a real interface or the stock chat, how
 * big, what it reads, which AIs it calls on its own, which situations run an
 * AI, how many behaviours, and whether the "card" is really a native game the
 * platform hosts (PvZ) that no card could reproduce.
 *
 * Pure: the server computes it for the card page, the Studio can compute it
 * for the creator, the agent API can hand it to an outside AI.
 */
export interface CustomizationSummary {
  /** Null for the stock chat with no code of its own. */
  frontend: null | {
    files: number;
    bytes: number;
    lines: number;
    /** Built from a UI doc (the visual editor) rather than hand-written. */
    fromUiDoc: boolean;
    /** Variable names the interface reads / writes with a literal key. */
    reads: string[];
    writes: string[];
    dynamicReads: number;
    dynamicWrites: number;
    /** AI calls the interface makes on its own. */
    aiCalls: number;
    /** Names of the situations (worldbooks) those calls restrict lore to. */
    aiCallTargets: string[];
    /** Calls that choose their situation at runtime. */
    aiCallsDynamic: number;
    /** Platform API families the code leans on, beyond variables. */
    uses: FrontendApiFamily[];
    /** The files that do the most, for a reader who wants a way in. */
    topFiles: Array<Pick<FrontendFileFacts, "file" | "bytes" | "lines" | "reads" | "writes" | "uses"> & { aiCalls: number }>;
  };
  uiDoc: null | { pages: number; elements: number };
  variables: {
    total: number;
    json: number;
    /** `aiAccess: "none"` — state the AI never sees; moved by code alone. */
    hiddenFromAi: number;
    /** Variables with declared fields (see VariableField). */
    withFields: number;
    /** Declared fields, across all variables. */
    fields: number;
  };
  entries: { total: number; playerFacing: number };
  situations: {
    total: number;
    /** Situations that run an AI of their own (a station). */
    withOwnAi: number;
    aiNames: string[];
  };
  behaviors: number;
  audioTracks: number;
  sceneImages: number;
  /** The card is a first-party native game served by the platform. */
  nativeGame: null | { path: string };
}

export interface SummarizeOptions {
  /** `worlds.game_path` / `schema.game.path` — the native-game marker. */
  gamePath?: string | null;
}

export function summarizeCustomization(world: Partial<WorldDefinition>, opts: SummarizeOptions = {}): CustomizationSummary {
  const books = world.worldbooks ?? [];
  const bookName = (id: string) => {
    const b = books.find((x) => x.id === id);
    return b ? (b.station?.name?.trim() || b.name) : id;
  };

  let frontend: CustomizationSummary["frontend"] = null;
  const root = world.rootComponent;
  if (root && Object.keys(root.files).length > 0) {
    const m = frontendManifest(root.files, root.entryFile);
    // The stock chat is one line of code; a card whose only file renders
    // `<Chat/>` has no interface of its own.
    const stock = m.files.length === 1 && m.bytes < 400 && m.aiCalls.length === 0 && m.reads.length === 0 && /createElement\(\s*Chat\s*\)|<Chat\s*\/>/.test(Object.values(root.files)[0] ?? "");
    if (!stock) {
      // A literal id names its module; a template's fixed prefix names the
      // modules the call can choose between (`still-${who}` → still-estragon,
      // still-vladimir).
      const ids = new Set<string>();
      for (const c of m.aiCalls) {
        for (const id of c.worldbookIds) ids.add(id);
        for (const prefix of c.worldbookIdPrefixes) for (const b of books) if (b.id.startsWith(prefix)) ids.add(b.id);
      }
      const targets = [...ids].map(bookName);
      frontend = {
        files: m.files.length, bytes: m.bytes, lines: m.lines,
        fromUiDoc: root.generatedFrom === "uiDoc",
        reads: m.reads, writes: m.writes,
        dynamicReads: m.dynamicReads, dynamicWrites: m.dynamicWrites,
        aiCalls: m.aiCalls.length, aiCallTargets: targets,
        aiCallsDynamic: m.aiCalls.filter((c) => c.dynamicWorldbookIds).length,
        uses: m.uses,
        topFiles: m.files.slice(0, 6).map((f) => ({ file: f.file, bytes: f.bytes, lines: f.lines, reads: f.reads, writes: f.writes, uses: f.uses, aiCalls: f.aiCalls.length })),
      };
    }
  }

  const uiDoc = world.uiDoc
    ? { pages: world.uiDoc.pages.length, elements: world.uiDoc.pages.reduce((n, p) => n + p.elements.length, 0) }
    : null;

  const vars = world.variables ?? [];
  const entries = world.entries ?? [];
  const stations = books.filter((b) => resolveStation(b));
  const gamePath = opts.gamePath ?? (world as unknown as { game?: { path?: string } }).game?.path ?? null;

  return {
    frontend,
    uiDoc,
    variables: {
      total: vars.length,
      json: vars.filter((v) => v.type === "json").length,
      hiddenFromAi: vars.filter((v) => v.aiAccess === "none").length,
      withFields: vars.filter((v) => v.fields?.length).length,
      fields: vars.reduce((n, v) => n + (v.fields?.length ?? 0), 0),
    },
    entries: {
      total: entries.length,
      playerFacing: entries.filter((e) => e.audience === "player" || e.audience === "both").length,
    },
    situations: {
      total: books.length,
      withOwnAi: stations.length,
      aiNames: stations.map((b) => b.station?.name?.trim() || b.name),
    },
    behaviors: (world.reactions?.length ?? 0) + (world.rules?.length ?? 0),
    audioTracks: world.audioTracks?.length ?? 0,
    sceneImages: world.sceneImages?.length ?? 0,
    nativeGame: gamePath ? { path: gamePath } : null,
  };
}
