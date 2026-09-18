import { describe, expect, it } from "vitest";
import { migrateWorldDefinition, migrateV18ToV19, migrateV19ToV20, migrateV20ToV21 } from "../migration/migrate-v1-to-v2.js";
import type { WorldDefinition } from "../types/index.js";

describe("migrateWorldDefinition", () => {
  it("normalizes legacy lore and personality roles onto system and character", () => {
    // Pre-migration entries intentionally lack section/order — the migration adds them
    const world = {
      id: "world-1",
      version: "10.0.0",
      name: "Legacy World",
      description: "",
      author: "",
      entries: [
        {
          id: "entry-1",
          name: "Legacy Personality",
          content: "personality",
          role: "personality",
          position: "character",
          alwaysSend: true,
          keywords: [],
          conditions: [],
          conditionLogic: "all",
          priority: 10,
          enabled: true,
        },
        {
          id: "entry-2",
          name: "Legacy Lore",
          content: "lore",
          role: "lore",
          position: "after_char",
          alwaysSend: true,
          keywords: [],
          conditions: [],
          conditionLogic: "all",
          priority: 9,
          enabled: true,
        },
      ],
      variables: [],
      rules: [],
      components: [],
      audioTracks: [],
      customComponents: [],
      settings: {
        maxTokens: 12000,
        maxContext: 200000,
        temperature: 1,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        playerName: "User",
        lorebookScanDepth: 2,
        lorebookRecursionDepth: 0,
      },
    };

    const migrated = migrateWorldDefinition(world as WorldDefinition);

    expect(migrated.entries[0]?.role).toBe("character");
    expect(migrated.entries[1]?.role).toBe("system");
  });

  it("fills schema-defaulted keywords/enabled on entries that omit them (imported/sparse cards)", () => {
    // An imported card whose entries carry only id/name/content/role/section —
    // editor list code reads `entry.keywords.length` and would crash on undefined.
    const world = {
      id: "w",
      version: "19.0.0",
      name: "Sparse",
      description: "",
      author: "",
      entries: [
        { id: "e1", name: "Char", content: "...", role: "character", section: "system-presets" },
      ],
      variables: [],
      rules: [],
      components: [],
      audioTracks: [],
      settings: { maxTokens: 12000 },
    } as unknown as WorldDefinition;

    const migrated = migrateWorldDefinition(world);
    expect(Array.isArray(migrated.entries[0]?.keywords)).toBe(true);
    expect(migrated.entries[0]?.keywords).toEqual([]);
    expect(migrated.entries[0]?.enabled).toBe(true);
  });
});

describe("migrateV18ToV19", () => {
  const baseWorld = {
    id: "world-1",
    version: "18.0.0",
    name: "Test World",
    description: "",
    author: "",
    entries: [],
    variables: [],
    rules: [],
    components: [],
    audioTracks: [],
    customComponents: [],
    settings: {
      maxTokens: 12000,
      maxContext: 200000,
      temperature: 1,
      playerName: "User",
      lorebookScanDepth: 2,
      lorebookRecursionDepth: 0,
    },
  } as unknown as WorldDefinition;

  it("migrates messageRenderer only → customUI with surface:message", () => {
    const world = {
      ...baseWorld,
      messageRenderer: {
        id: "mr-1",
        name: "My Renderer",
        tsxCode: "export default () => <div/>",
        description: "test",
        order: 0,
        visible: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    } as unknown as WorldDefinition;

    const result = migrateV18ToV19(world);
    expect(result.version).toBe("19.0.0");
    expect(result.customUI).toHaveLength(1);
    expect(result.customUI[0]?.surface).toBe("message");
    expect(result.customUI[0]?.tsxCode).toBe("export default () => <div/>");
    expect(result.customUI[0]?.name).toBe("My Renderer");
  });

  it("migrates customComponents with fullScreenComponent:false → all surface:app", () => {
    const world = {
      ...baseWorld,
      customComponents: [
        { id: "cc-1", name: "Widget A", tsxCode: "<div>A</div>", description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" },
        { id: "cc-2", name: "Widget B", tsxCode: "<div>B</div>", description: "", order: 1, visible: true, updatedAt: "2026-01-01T00:00:00Z" },
      ],
      settings: { ...baseWorld.settings, fullScreenComponent: false },
    } as unknown as WorldDefinition;

    const result = migrateV18ToV19(world);
    expect(result.customUI).toHaveLength(2);
    expect(result.customUI[0]?.surface).toBe("app");
    expect(result.customUI[1]?.surface).toBe("app");
  });

  it("migrates customComponents with fullScreenComponent:true, 1 component → surface:app", () => {
    const world = {
      ...baseWorld,
      customComponents: [
        { id: "cc-1", name: "VN Engine", tsxCode: "<div>VN</div>", description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" },
      ],
      settings: { ...baseWorld.settings, fullScreenComponent: true },
    } as unknown as WorldDefinition;

    const result = migrateV18ToV19(world);
    expect(result.customUI).toHaveLength(1);
    expect(result.customUI[0]?.surface).toBe("app");
  });

  it("migrates fullScreenComponent:true with N components → all surface:app", () => {
    const world = {
      ...baseWorld,
      customComponents: [
        { id: "cc-1", name: "Main App", tsxCode: "<div>Main</div>", description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" },
        { id: "cc-2", name: "Sidebar", tsxCode: "<div>Side</div>", description: "", order: 1, visible: true, updatedAt: "2026-01-01T00:00:00Z" },
        { id: "cc-3", name: "Footer", tsxCode: "<div>Footer</div>", description: "", order: 2, visible: true, updatedAt: "2026-01-01T00:00:00Z" },
      ],
      settings: { ...baseWorld.settings, fullScreenComponent: true },
    } as unknown as WorldDefinition;

    const result = migrateV18ToV19(world);
    expect(result.customUI).toHaveLength(3);
    expect(result.customUI[0]?.surface).toBe("app");
    expect(result.customUI[0]?.name).toBe("Main App");
    expect(result.customUI[1]?.surface).toBe("app");
    expect(result.customUI[2]?.surface).toBe("app");
  });

  it("migrates world with both messageRenderer AND customComponents", () => {
    const world = {
      ...baseWorld,
      messageRenderer: {
        id: "mr-1",
        name: "Renderer",
        tsxCode: "<div>msg</div>",
        description: "",
        order: 0,
        visible: true,
        updatedAt: "2026-01-01T00:00:00Z",
      },
      customComponents: [
        { id: "cc-1", name: "Widget", tsxCode: "<div>widget</div>", description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" },
      ],
      settings: { ...baseWorld.settings, fullScreenComponent: false },
    } as unknown as WorldDefinition;

    const result = migrateV18ToV19(world);
    expect(result.customUI).toHaveLength(2);
    expect(result.customUI.find(c => c.surface === "message")).toBeDefined();
    expect(result.customUI.find(c => c.surface === "app")).toBeDefined();
  });

  it("migrates world with no custom UI → empty customUI[]", () => {
    const result = migrateV18ToV19(baseWorld);
    expect(result.version).toBe("19.0.0");
    expect(result.customUI).toHaveLength(0);
  });

  it("v19 worlds no longer pass through — they promote to the latest version via migrateWorldDefinition", () => {
    // Historically v19 was the terminal version and this test asserted pass-through.
    // v19 worlds get promoted through v20 (customUI → rootComponent) to the latest schema.
    const world = {
      ...baseWorld,
      version: "19.0.0",
      customUI: [
        { id: "ui-1", name: "Test", surface: "message", tsxCode: "<div/>", description: "", order: 0, visible: true, updatedAt: "2026-01-01T00:00:00Z" },
      ],
    } as unknown as WorldDefinition;

    const result = migrateWorldDefinition(world);
    expect(result.version).toBe("21.0.0");
    expect(result.customUI).toHaveLength(0);
    expect(result.rootComponent).toBeDefined();
    expect(result.rootComponent?.entryFile).toBe("index.tsx");
  });
});

describe("migrateV20ToV21", () => {
  const baseWorld = {
    id: "folder-world",
    version: "20.0.0",
    name: "Folders",
    description: "",
    author: "",
    entries: [],
    variables: [],
    rules: [],
    components: [],
    audioTracks: [],
    customUI: [],
    worldbooks: [
      { id: "book-a", name: "A", activation: { mode: "always" }, order: 0 },
      { id: "book-b", name: "B", activation: { mode: "always" }, order: 1 },
    ],
    settings: { maxTokens: 12000 },
  } as unknown as WorldDefinition;

  const legacyEntry = (id: string, folderId: string, worldbookId?: string) => ({
    id,
    name: id,
    content: "",
    role: "custom" as const,
    alwaysSend: false,
    keywords: [],
    conditions: [],
    conditionLogic: "all" as const,
    enabled: true,
    position: 0,
    section: "system-presets" as const,
    folderId,
    worldbookId,
  });

  it("assigns a legacy folder to the only knowledge base that references it", () => {
    const result = migrateV20ToV21({
      ...baseWorld,
      entries: [legacyEntry("e1", "folder-1", "book-a")],
      entryFolders: [{ id: "folder-1", name: "People", section: "system-presets", order: 0 }],
    });

    expect(result.version).toBe("21.0.0");
    expect(result.entryFolders).toEqual([
      { id: "folder-1", name: "People", section: "system-presets", order: 0, worldbookId: "book-a" },
    ]);
    expect(result.entries[0]!.folderId).toBe("folder-1");
  });

  it("splits a shared legacy folder into independent per-book folders", () => {
    const world = {
      ...baseWorld,
      entries: [
        legacyEntry("core-entry", "shared"),
        legacyEntry("book-entry", "shared", "book-b"),
      ],
      entryFolders: [{ id: "shared", name: "Characters", section: "system-presets", order: 0 }],
      installedBundles: [{
        installId: "install-1",
        name: "Bundle",
        colorKey: "blue",
        importedAt: "2026-01-01",
        originalHash: "hash",
        entryIds: ["core-entry", "book-entry"],
        variableIds: [],
        ruleIds: [],
        audioTrackIds: [],
        folderIds: ["shared"],
      }],
    } as WorldDefinition;

    const result = migrateV20ToV21(world);
    expect(result.entryFolders).toHaveLength(2);
    expect(result.entryFolders![0]).toMatchObject({ id: "shared", worldbookId: undefined });
    expect(result.entryFolders![1]).toMatchObject({ name: "Characters", worldbookId: "book-b" });
    expect(result.entries[0]!.folderId).toBe("shared");
    expect(result.entries[1]!.folderId).toBe(result.entryFolders![1]!.id);
    expect(result.installedBundles![0]!.folderIds).toEqual(result.entryFolders!.map((folder) => folder.id));
  });

  it("puts an unreferenced legacy folder in Main/Core", () => {
    const result = migrateV20ToV21({
      ...baseWorld,
      entryFolders: [{ id: "empty", name: "Empty", section: "post-history", order: 0 }],
    });
    expect(result.entryFolders![0]!.worldbookId).toBeUndefined();
  });

  it("is deterministic and idempotent through the public migrator", () => {
    const world = {
      ...baseWorld,
      entries: [legacyEntry("a", "shared", "book-a"), legacyEntry("b", "shared", "book-b")],
      entryFolders: [{ id: "shared", name: "Shared", section: "system-presets", order: 0 }],
    } as WorldDefinition;
    const first = migrateWorldDefinition(world);
    const sameInput = migrateWorldDefinition(structuredClone(world));
    const second = migrateWorldDefinition(first);
    expect(first).toEqual(sameInput);
    expect(second).toEqual(first);
  });
});

describe("migrateV19ToV20", () => {
  // Mirrors the shapes seen in the prod audit:
  //   Stray Diary         — 1× surface:"app"
  //   绝世唐门             — 1× surface:"message"
  //   火凤燎原             — message + app combo (the 2-3 component tail)
  //   empty               — 235 of 525 prod worlds have no customUI
  //   already-v2          — 123 of 648 worlds already have rootComponent
  const baseWorld = {
    id: "world-v19",
    version: "19.0.0",
    name: "Test",
    description: "",
    author: "",
    entries: [],
    variables: [],
    rules: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: {
      maxTokens: 12000,
      maxContext: 200000,
      temperature: 1,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      playerName: "User",
      lorebookScanDepth: 2,
      lorebookRecursionDepth: 0,
    },
  };

  it("empty customUI → rootComponent with default <Chat />", () => {
    const result = migrateV19ToV20({ ...baseWorld } as unknown as WorldDefinition);
    expect(result.version).toBe("20.0.0");
    expect(result.customUI).toEqual([]);
    expect(result.rootComponent).toBeDefined();
    expect(result.rootComponent?.entryFile).toBe("index.tsx");
    expect(result.rootComponent?.files["index.tsx"]).toContain("Chat");
  });

  it("single surface:'app' → rootComponent with that code as index.tsx", () => {
    const appCode = "export default function StrayDiary() { return React.createElement('div'); }";
    const world = {
      ...baseWorld,
      customUI: [{ id: "a", name: "A", surface: "app", language: "tsx", tsxCode: appCode, description: "", order: 0, visible: true, updatedAt: "2026-01-01" }],
    } as unknown as WorldDefinition;

    const result = migrateV19ToV20(world);
    expect(result.rootComponent?.entryFile).toBe("index.tsx");
    // Single app becomes app-0.tsx + an entry file that mounts it.
    expect(result.rootComponent?.files["app-0.tsx"]).toBe(appCode);
    expect(result.rootComponent?.files["index.tsx"]).toContain("App0");
    expect(result.customUI).toEqual([]);
  });

  it("single surface:'message' → rootComponent with <Chat renderBubble={Bubble}/>", () => {
    const bubbleCode = "export default function Bubble({ content }) { return React.createElement('div', null, content); }";
    const world = {
      ...baseWorld,
      customUI: [{ id: "m", name: "Msg", surface: "message", language: "tsx", tsxCode: bubbleCode, description: "", order: 0, visible: true, updatedAt: "2026-01-01" }],
    } as unknown as WorldDefinition;

    const result = migrateV19ToV20(world);
    expect(result.rootComponent?.files["bubble.tsx"]).toBe(bubbleCode);
    expect(result.rootComponent?.files["index.tsx"]).toContain("renderBubble");
    expect(result.rootComponent?.files["index.tsx"]).toContain("Bubble");
  });

  it("multiple surface:'app' → stacked via imports in entry file", () => {
    const world = {
      ...baseWorld,
      customUI: [
        { id: "a1", name: "A1", surface: "app", language: "tsx", tsxCode: "CODE_A1", description: "", order: 0, visible: true, updatedAt: "2026-01-01" },
        { id: "a2", name: "A2", surface: "app", language: "tsx", tsxCode: "CODE_A2", description: "", order: 1, visible: true, updatedAt: "2026-01-01" },
      ],
    } as unknown as WorldDefinition;

    const result = migrateV19ToV20(world);
    expect(result.rootComponent?.files["app-0.tsx"]).toBe("CODE_A1");
    expect(result.rootComponent?.files["app-1.tsx"]).toBe("CODE_A2");
    const entry = result.rootComponent?.files["index.tsx"] ?? "";
    expect(entry).toContain("App0");
    expect(entry).toContain("App1");
  });

  it("message + app combo → entry stacks Chat + each app", () => {
    const world = {
      ...baseWorld,
      customUI: [
        { id: "m", name: "Msg", surface: "message", language: "tsx", tsxCode: "MSG_CODE", description: "", order: 0, visible: true, updatedAt: "2026-01-01" },
        { id: "a", name: "App", surface: "app", language: "tsx", tsxCode: "APP_CODE", description: "", order: 0, visible: true, updatedAt: "2026-01-01" },
      ],
    } as unknown as WorldDefinition;

    const result = migrateV19ToV20(world);
    expect(result.rootComponent?.files["bubble.tsx"]).toBe("MSG_CODE");
    expect(result.rootComponent?.files["app-0.tsx"]).toBe("APP_CODE");
    const entry = result.rootComponent?.files["index.tsx"] ?? "";
    expect(entry).toContain("renderBubble");
    expect(entry).toContain("App0");
  });

  it("invisible components are dropped (they never rendered in v1 either)", () => {
    const world = {
      ...baseWorld,
      customUI: [
        { id: "a1", name: "A1", surface: "app", language: "tsx", tsxCode: "VISIBLE", description: "", order: 0, visible: true, updatedAt: "2026-01-01" },
        { id: "a2", name: "A2", surface: "app", language: "tsx", tsxCode: "HIDDEN", description: "", order: 1, visible: false, updatedAt: "2026-01-01" },
      ],
    } as unknown as WorldDefinition;

    const result = migrateV19ToV20(world);
    expect(result.rootComponent?.files["app-0.tsx"]).toBe("VISIBLE");
    expect(result.rootComponent?.files["app-1.tsx"]).toBeUndefined();
  });

  it("already-has-rootComponent → pass through, clear customUI[] only", () => {
    const existingRoot = {
      id: "root-existing",
      name: "Root",
      entryFile: "main.tsx",
      files: { "main.tsx": "EXISTING" },
      updatedAt: "2026-04-01",
    };
    const world = {
      ...baseWorld,
      rootComponent: existingRoot,
      customUI: [{ id: "stale", name: "Stale", surface: "app", language: "tsx", tsxCode: "LEFTOVER", description: "", order: 0, visible: true, updatedAt: "2026-01-01" }],
    } as unknown as WorldDefinition;

    const result = migrateV19ToV20(world);
    // rootComponent must be preserved exactly — creator's hand-authored files.
    expect(result.rootComponent).toEqual(existingRoot);
    // Stale v1 customUI gets cleared so both fields don't represent divergent state.
    expect(result.customUI).toEqual([]);
    expect(result.version).toBe("20.0.0");
  });

  it("verbatim preservation: creator TSX code is not modified byte-for-byte", () => {
    // This is the safety property that makes migration low-risk on real worlds.
    // Whatever regex/string manipulation we do must never touch the inner code.
    const gnarly = "var h = React.createElement; /* @asset:abc */ return h('div', { style: { background: 'red' } }, '\\n\\t');";
    const world = {
      ...baseWorld,
      customUI: [{ id: "a", name: "A", surface: "app", language: "tsx", tsxCode: gnarly, description: "", order: 0, visible: true, updatedAt: "2026-01-01" }],
    } as unknown as WorldDefinition;

    const result = migrateV19ToV20(world);
    expect(result.rootComponent?.files["app-0.tsx"]).toBe(gnarly);
  });
});
