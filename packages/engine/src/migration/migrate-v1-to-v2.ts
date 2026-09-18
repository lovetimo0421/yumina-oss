import type { RootComponent, WorldDefinition } from "../types/index.js";

/**
 * World schema migration.
 *
 * All DB worlds were batch-migrated to v17 on 2026-03-17.
 * v18→v19: Unify messageRenderer + customComponents + fullScreenComponent
 *          into a single customUI[] array with surface field.
 * v19→v20: Collapse customUI[] + surface into a single rootComponent +
 *          multi-file virtual filesystem. Every world has exactly one root
 *          React component; v1's surface XOR constraint is gone. Migration
 *          preserves creator code verbatim — app-surface components each
 *          become their own file, message-surface renderer becomes a
 *          renderBubble-wrapped file. Worlds that already have rootComponent
 *          pass through; worlds with empty customUI get a default <Chat/> root.
 * v20→v21: Scope entry folders to one knowledge base. Legacy folders referenced
 *          from multiple books are split deterministically so the books no
 *          longer share the same mutable folder object.
 *
 * Current version: 21.0.0
 */
export function migrateWorldDefinition(raw: WorldDefinition): WorldDefinition {
  const version = raw.version ? parseFloat(raw.version) : 0;

  if (version >= 21.0) {
    return normalizeEntryRoles(raw);
  }

  if (version >= 20.0) {
    return normalizeEntryRoles(migrateV20ToV21(raw));
  }

  if (version >= 19.0) {
    return normalizeEntryRoles(migrateV20ToV21(migrateV19ToV20(raw)));
  }

  if (version >= 18.0) {
    return normalizeEntryRoles(migrateV20ToV21(migrateV19ToV20(migrateV18ToV19(raw))));
  }

  if (version >= 17.0) {
    return normalizeEntryRoles(migrateV20ToV21(migrateV19ToV20(migrateV18ToV19(migrateV17ToV18(raw)))));
  }

  // Pre-v17 worlds should not exist in the DB anymore.
  return normalizeEntryRoles(migrateV20ToV21(migrateV19ToV20(migrateV18ToV19(migrateV17ToV18({ ...raw, version: "17.0.0" })))));
}

const CORE_WORLDBOOK_KEY = "\u0000core";

function worldbookKey(worldbookId: string | undefined): string {
  return worldbookId ?? CORE_WORLDBOOK_KEY;
}

function folderScopeKey(folderId: string, worldbookId: string | undefined): string {
  return `${folderId}\u0000${worldbookKey(worldbookId)}`;
}

function stableIdHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function derivedFolderId(baseId: string, scopeKey: string, usedIds: Set<string>): string {
  const suffix = scopeKey === CORE_WORLDBOOK_KEY ? "core" : stableIdHash(scopeKey);
  const stem = `${baseId}--${suffix}`;
  let candidate = stem;
  let n = 2;
  while (usedIds.has(candidate)) candidate = `${stem}-${n++}`;
  usedIds.add(candidate);
  return candidate;
}

/**
 * v20 → v21: folders become children of one knowledge base instead of a global
 * card-wide list. The legacy model allowed one folder id to be referenced by
 * entries from several books, so migration clones that folder per book and
 * rewrites the references. IDs are deterministic: client, server, and offline
 * migration must produce the same schema from the same input.
 */
export function migrateV20ToV21(raw: WorldDefinition): WorldDefinition {
  const legacyFolders = raw.entryFolders ?? [];
  if (legacyFolders.length === 0) return { ...raw, version: "21.0.0" };

  const worldbookOrder = new Map((raw.worldbooks ?? []).map((book, index) => [book.id, index]));
  const entriesByFolder = new Map<string, WorldDefinition["entries"]>();
  for (const entry of raw.entries ?? []) {
    if (!entry.folderId) continue;
    const list = entriesByFolder.get(entry.folderId) ?? [];
    list.push(entry);
    entriesByFolder.set(entry.folderId, list);
  }

  const compareScope = (a: string, b: string): number => {
    if (a === CORE_WORLDBOOK_KEY) return b === CORE_WORLDBOOK_KEY ? 0 : -1;
    if (b === CORE_WORLDBOOK_KEY) return 1;
    const ao = worldbookOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bo = worldbookOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ao - bo || a.localeCompare(b);
  };

  const usedIds = new Set(legacyFolders.map((folder) => folder.id));
  const remappedIds = new Map<string, string>();
  const replacementsByOriginal = new Map<string, string[]>();
  const entryFolders: NonNullable<WorldDefinition["entryFolders"]> = [];

  for (const folder of legacyFolders) {
    const referencingEntries = entriesByFolder.get(folder.id) ?? [];
    const inferredScopes = new Set(referencingEntries.map((entry) => worldbookKey(entry.worldbookId)));
    const scopes = folder.worldbookId
      ? [worldbookKey(folder.worldbookId)]
      : inferredScopes.size > 0
        ? [...inferredScopes].sort(compareScope)
        : [CORE_WORLDBOOK_KEY];

    const replacementIds: string[] = [];
    scopes.forEach((scope, index) => {
      const id = index === 0 ? folder.id : derivedFolderId(folder.id, scope, usedIds);
      const worldbookId = scope === CORE_WORLDBOOK_KEY ? undefined : scope;
      remappedIds.set(folderScopeKey(folder.id, worldbookId), id);
      replacementIds.push(id);
      entryFolders.push({ ...folder, id, worldbookId });
    });
    replacementsByOriginal.set(folder.id, replacementIds);
  }

  const entries = raw.entries.map((entry) => {
    if (!entry.folderId) return entry;
    const remapped = remappedIds.get(folderScopeKey(entry.folderId, entry.worldbookId));
    return remapped && remapped !== entry.folderId ? { ...entry, folderId: remapped } : entry;
  });

  const installedBundles = raw.installedBundles?.map((bundle) => {
    const folderIds = [...new Set(bundle.folderIds.flatMap((id) => replacementsByOriginal.get(id) ?? [id]))];
    return folderIds.length === bundle.folderIds.length && folderIds.every((id, index) => id === bundle.folderIds[index])
      ? bundle
      : { ...bundle, folderIds };
  });

  return {
    ...raw,
    version: "21.0.0",
    entries,
    entryFolders,
    ...(installedBundles ? { installedBundles } : {}),
  };
}

/** v17 → v18: Delete world-info section, move instructions to system-presets. */
function migrateV17ToV18(raw: WorldDefinition): WorldDefinition {
  const entries = raw.entries.map((entry) => {
    // Migrate world-info entries to chat-history with depth injection
    if ((entry as any).section === "world-info") {
      return { ...entry, section: "chat-history" as const, depth: entry.depth ?? 4 };
    }
    // Move instructions preset back to system-presets
    if (entry.presetId === "instructions") {
      return { ...entry, section: "system-presets" as const, position: 2 };
    }
    // Bump style preset position
    if (entry.presetId === "style") {
      return { ...entry, position: 3 };
    }
    // CoT bypass position reset
    if (entry.presetId === "cot-bypass") {
      return { ...entry, position: 0 };
    }
    return entry;
  });

  // Migrate entry folders too
  const entryFolders = (raw.entryFolders ?? []).map((folder) => {
    if ((folder as any).section === "world-info") {
      return { ...folder, section: "chat-history" as const };
    }
    return folder;
  });

  return { ...raw, entries, entryFolders, version: "18.0.0" };
}

/**
 * v18 → v19: Unify messageRenderer + customComponents[] + fullScreenComponent
 * into a single customUI[] array with a surface enum field.
 *
 *   messageRenderer        → customUI[{ surface: "message" }]
 *   customComponents[]     → customUI[{ surface: "app" }]
 */
export function migrateV18ToV19(raw: WorldDefinition): WorldDefinition {
  // Already migrated or has customUI — skip
  if ((raw as any).customUI?.length > 0) {
    return { ...raw, version: "19.0.0" };
  }

  const customUI: Array<{
    id: string;
    name: string;
    surface: "message" | "app";
    tsxCode: string;
    description: string;
    order: number;
    visible: boolean;
    updatedAt: string;
  }> = [];

  const usedIds = new Set<string>();

  // Migrate messageRenderer → surface: "message"
  const renderer = (raw as any).messageRenderer;
  if (renderer?.tsxCode) {
    const id = renderer.id ?? "message-renderer";
    usedIds.add(id);
    customUI.push({
      id,
      name: renderer.name ?? "Message Renderer",
      surface: "message",
      tsxCode: renderer.tsxCode,
      description: renderer.description ?? "",
      order: 0,
      visible: true,
      updatedAt: renderer.updatedAt ?? new Date().toISOString(),
    });
  }

  // Migrate customComponents → surface: "app"
  const comps = [...((raw as any).customComponents ?? [])].sort(
    (a: any, b: any) => (a.order ?? 0) - (b.order ?? 0),
  );

  for (let i = 0; i < comps.length; i++) {
    const comp = comps[i];
    let id = comp.id;
    if (usedIds.has(id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
    usedIds.add(id);

    customUI.push({
      id,
      name: comp.name,
      surface: "app",
      tsxCode: comp.tsxCode ?? "",
      description: comp.description ?? "",
      order: comp.order ?? i,
      visible: comp.visible ?? true,
      updatedAt: comp.updatedAt ?? new Date().toISOString(),
    });
  }

  return { ...raw, customUI, version: "19.0.0" } as WorldDefinition;
}

/**
 * v19 → v20: Collapse customUI[] (with surface field) into a single rootComponent.
 *
 * Mapping rules (verified against prod audit — 648 worlds):
 *
 *   Empty customUI[]                 → rootComponent with entry = default <Chat />
 *   1× surface:"app"                 → rootComponent with entry = that code verbatim
 *   N× surface:"app"                 → rootComponent with entry = stack importing each
 *                                      app-N.tsx file (each file = one app verbatim)
 *   1× surface:"message"             → rootComponent entry = <Chat renderBubble={Bubble}/>,
 *                                      bubble.tsx = that code verbatim
 *   1× message + M× app              → entry stacks <Chat renderBubble> + each app
 *   rootComponent already exists     → pass through; clear customUI[]
 *
 * IMPORTANT compat note: v1 message renderers destructure `content` (HTML),
 * v2 <Chat renderBubble> passes `contentHtml`. We add an alias in
 * packages/app/sandbox/building-blocks/chat.tsx so both names are usable —
 * existing v1-style renderers keep working after migration with zero code
 * edits on the creator's side.
 *
 * The v1 `customUI` field is cleared (set to []) after migration so subsequent
 * reads don't re-migrate. Legacy fields `messageRenderer` + `customComponents[]`
 * were already absorbed into customUI[] by v18→v19, so nothing to do there.
 */
export function migrateV19ToV20(raw: WorldDefinition): WorldDefinition {
  // Already has rootComponent — just clear any stale customUI[] and bump version.
  if ((raw as any).rootComponent) {
    return {
      ...raw,
      customUI: [],
      version: "20.0.0",
    } as WorldDefinition;
  }

  const customUI = ((raw as any).customUI ?? []) as LegacyCustomUIShape[];
  const now = new Date().toISOString();
  const rootId = (raw.id ?? "") + ":root";

  return {
    ...raw,
    rootComponent: {
      id: rootId,
      name: "Root",
      entryFile: "index.tsx",
      files: customUIToRootFiles(customUI),
      updatedAt: now,
    },
    customUI: [],
    version: "20.0.0",
  } as WorldDefinition;
}

/** Minimal shape we need from a v1/v19 CustomUIComponent when converting. */
interface LegacyCustomUIShape {
  id?: string;
  name?: string;
  surface: "message" | "app";
  tsxCode?: string;
  language?: "tsx" | "html" | "markdown";
  visible?: boolean;
  order?: number;
}

/**
 * Convert a legacy customUI[] array into a rootComponent.files map.
 *
 * Used by:
 *   - migrateV19ToV20 (per-world migration on load)
 *   - the bundle importer (when a pre-v3 bundle arrives with customUI[] instead
 *     of a rootComponent)
 *
 * Returns a `files` record keyed by filename. The entry file is always
 * `index.tsx`; callers set `entryFile` themselves. Invisible components are
 * dropped (v1 behavior — they never rendered).
 *
 * Empty or all-invisible input → a single `index.tsx` with the default Chat.
 */
export function customUIToRootFiles(customUI: LegacyCustomUIShape[]): Record<string, string> {
  if (customUI.length === 0) {
    return { "index.tsx": DEFAULT_CHAT_ROOT };
  }

  // Only keep visible components — invisible ones were never rendered in v1.
  const visible = customUI.filter((c) => c.visible !== false);

  if (visible.length === 0) {
    return { "index.tsx": DEFAULT_CHAT_ROOT };
  }

  const messageComps = visible.filter((c) => c.surface === "message");
  const appComps = visible
    .filter((c) => c.surface === "app")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Only the first message renderer is honored — v1's XOR rule allowed one.
  const messageComp = messageComps[0];

  const files: Record<string, string> = {};
  const imports: string[] = [];
  const jsxElements: string[] = [];

  if (messageComp && (!messageComp.language || messageComp.language === "tsx")) {
    files["bubble.tsx"] = messageComp.tsxCode ?? "";
    imports.push(`import Bubble from "./bubble";`);
    jsxElements.push(`React.createElement(Chat, { renderBubble: Bubble })`);
  }

  appComps.forEach((app, i) => {
    const filename = `app-${i}.tsx`;
    files[filename] = app.tsxCode ?? "";
    const safeName = `App${i}`;
    imports.push(`import ${safeName} from "./${filename.replace(/\.tsx$/, "")}";`);
    jsxElements.push(`React.createElement(${safeName})`);
  });

  if (jsxElements.length === 0) {
    jsxElements.push(`React.createElement(Chat)`);
  }

  files["index.tsx"] = `${imports.join("\n")}

export default function App() {
  return React.createElement(React.Fragment, null, ${jsxElements.join(", ")});
}
`;

  return files;
}

/** Default root for a world with no custom visual layer — renders the
 *  platform chat with markdown. Exported so import pipelines can synthesize
 *  a compliant rootComponent without going through the migration path. */
export const DEFAULT_CHAT_ROOT = `export default function App() {
  return React.createElement(Chat);
}
`;

/** Build a default rootComponent for a brand-new world. */
export function makeDefaultRootComponent(worldId: string): RootComponent {
  return {
    id: `${worldId}:root`,
    name: "Root",
    entryFile: "index.tsx",
    files: { "index.tsx": DEFAULT_CHAT_ROOT },
    updatedAt: new Date().toISOString(),
  };
}

/** Normalize legacy role aliases (personality → character, lore → system). */
function normalizeEntryRoles(raw: WorldDefinition): WorldDefinition {
  let changed = false;

  const entries = raw.entries.map((entry) => {
    let role = entry.role;

    if (role === "personality") {
      role = "character";
    } else if (role === "lore") {
      role = "system";
    }

    // `keywords` and `enabled` are schema-defaulted, but migration runs BEFORE
    // any Zod parse — an imported/hand-authored card whose entries omit them
    // would otherwise reach render code (e.g. `entry.keywords.length`) and the
    // lorebook matcher with `undefined`, crashing the editor. Fill them here so
    // every load path (import, play, editor) sees well-formed entries.
    const needsKeywords = !Array.isArray(entry.keywords);
    const needsEnabled = typeof entry.enabled !== "boolean";

    if (role === entry.role && !needsKeywords && !needsEnabled) return entry;

    changed = true;
    return {
      ...entry,
      role,
      ...(needsKeywords ? { keywords: [] } : {}),
      ...(needsEnabled ? { enabled: true } : {}),
    };
  });

  return changed ? { ...raw, entries } : raw;
}
