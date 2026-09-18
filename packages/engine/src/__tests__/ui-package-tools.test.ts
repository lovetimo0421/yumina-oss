import { describe, expect, it } from "vitest";
import {
  diffUIPackageAgainstWorld,
  exportUIPackageFromWorld,
  uiPackageSchema,
  validateUIPackage,
  type UIPackage,
  type WorldDefinition,
} from "../index.js";

const variables: WorldDefinition["variables"] = [
  { id: "hp", name: "HP", type: "number", defaultValue: 100 },
  { id: "phase", name: "Phase", type: "string", defaultValue: "night" },
];

function basePackage(): UIPackage {
  return {
    format: "yumina.ui-package",
    schemaVersion: "1.0.0",
    metadata: {
      name: "Test Package",
      description: "Test",
      uiType: "status-bar",
      implementation: "ui-blueprint-only",
      tags: ["hud"],
      authoringMode: "ai-generated",
    },
    summary: {
      whatThisAdds: ["HP bar"],
      requiresVariableIds: ["hp"],
      notes: [],
    },
    uiBlueprint: {
      version: "1.0",
      theme: { preset: "default", tokens: {} },
      layouts: [{ id: "layout_hud", type: "stack", placement: "header", order: 0 }],
      components: [
        {
          id: "cmp_hp",
          type: "progress",
          layoutId: "layout_hud",
          order: 0,
          props: { min: 0, max: 100 },
        },
      ],
      bindings: [
        {
          id: "bind_cmp_hp_value",
          targetId: "cmp_hp",
          prop: "value",
          path: "vars.hp",
          transform: "number",
          fallback: 0,
        },
      ],
      triggers: [],
      interactions: [],
    },
    legacyComponents: [],
    messageRenderer: {
      enabled: false,
      name: "",
      tsxCode: "",
    },
    displaySettings: {
      fullScreenComponent: false,
    },
  };
}

describe("ui package tools", () => {
  it("validates a correct package", () => {
    const pkg = basePackage();
    const result = validateUIPackage(pkg, { variables, worldId: "w1" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports missing variable references", () => {
    const pkg = basePackage();
    pkg.summary.requiresVariableIds = ["hp", "missing_var"];
    pkg.uiBlueprint.bindings = [
      {
        id: "bind_missing",
        targetId: "cmp_hp",
        prop: "value",
        path: "vars.missing_var",
        transform: "number",
        fallback: 0,
      },
    ];
    const result = validateUIPackage(pkg, { variables, worldId: "w1" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("missing variable"))).toBe(
      true
    );
  });

  it("enforces transport mode requirements", () => {
    const pkg = basePackage();
    pkg.metadata.authoringMode = "ai-transported";
    pkg.summary.notes = ["Converted from old card"];

    const invalid = validateUIPackage(pkg, { variables, worldId: "w1" });
    expect(invalid.valid).toBe(false);
    expect(
      invalid.errors.some((error) => error.includes("sillytavern-port"))
    ).toBe(true);

    pkg.metadata.tags.push("sillytavern-port");
    pkg.summary.notes = [
      "Preserved: basic dashboard layout",
      "Adapted: regex marker rendering to messageRenderer",
      "Dropped: direct DOM mutation hooks",
      "Source check: regex_scripts and tavern_helper.scripts reviewed",
    ];
    const valid = validateUIPackage(pkg, { variables, worldId: "w1" });
    expect(valid.valid).toBe(true);
  });

  it("diffs package against world", () => {
    const pkg = basePackage();
    pkg.messageRenderer = {
      enabled: true,
      name: "Renderer",
      tsxCode: "export default function Renderer(){ return <div />; }",
    };
    pkg.displaySettings.fullScreenComponent = true;

    const world: Pick<
      WorldDefinition,
      "uiBlueprint" | "components" | "customUI" | "settings"
    > = {
      uiBlueprint: undefined,
      components: [],
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
        fullScreenComponent: false,
      },
    };

    const diff = diffUIPackageAgainstWorld(world, pkg);
    expect(diff.components.added).toContain("cmp_hp");
    expect(diff.messageRenderer.changed).toBe(true);
    expect(diff.displaySettings.changed).toBe(true);
  });

  it("exports a valid package from world", () => {
    const world: Pick<
      WorldDefinition,
      | "name"
      | "description"
      | "uiBlueprint"
      | "components"
      | "customUI"
      | "settings"
    > = {
      name: "Export World",
      description: "Export test",
      uiBlueprint: {
        version: "1.0",
        theme: { preset: "default", tokens: {} },
        layouts: [],
        components: [],
        bindings: [],
        triggers: [],
        interactions: [],
      },
      components: [],
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
        fullScreenComponent: false,
      },
    };

    const exported = exportUIPackageFromWorld(world);
    const parsed = uiPackageSchema.safeParse(exported);
    expect(parsed.success).toBe(true);
    expect(exported.format).toBe("yumina.ui-package");
  });

  it("preserves legacy-only worlds when exporting package", () => {
    const world: Pick<
      WorldDefinition,
      | "name"
      | "description"
      | "uiBlueprint"
      | "components"
      | "customUI"
      | "settings"
    > = {
      name: "Legacy World",
      description: "",
      uiBlueprint: undefined,
      components: [
        {
          id: "legacy_hp",
          type: "stat-bar",
          name: "HP",
          order: 0,
          visible: true,
          placement: "header",
          config: { variableId: "hp" },
        },
      ],
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
        fullScreenComponent: false,
      },
    };

    const exported = exportUIPackageFromWorld(world);
    expect(exported.legacyComponents).toHaveLength(1);
    expect(exported.legacyComponents[0]?.id).toBe("legacy_hp");
    expect(exported.uiBlueprint.components).toHaveLength(0);
  });
});
