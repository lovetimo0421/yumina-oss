import { describe, it, expect } from "vitest";
import { resolveUIBlueprint } from "../components/ui-blueprint-resolver.js";
import type { GameState, UIBlueprint, Variable } from "../types/index.js";

const vars: Variable[] = [
  { id: "hp", name: "HP", type: "number", defaultValue: 100, min: 0, max: 100 },
  { id: "phase", name: "Phase", type: "string", defaultValue: "night" },
  { id: "portrait", name: "Portrait", type: "string", defaultValue: "" },
];

function stateWith(values: Record<string, number | string | boolean>): GameState {
  return {
    worldId: "w",
    variables: values,
    turnCount: 0,
    metadata: {},
  };
}

describe("resolveUIBlueprint", () => {
  it("resolves progress widget with binding", () => {
    const blueprint: UIBlueprint = {
      version: "1.0",
      layouts: [],
      components: [
        {
          id: "hp-bar",
          type: "progress",
          name: "Health",
          props: { min: 0, max: 100 },
          order: 1,
        },
      ],
      bindings: [
        {
          id: "b1",
          targetId: "hp-bar",
          prop: "value",
          path: "vars.hp",
          transform: "number",
        },
      ],
      triggers: [],
      interactions: [],
    };

    const result = resolveUIBlueprint(blueprint, stateWith({ hp: 35, phase: "night", portrait: "" }), vars);
    expect(result.widgets).toHaveLength(1);
    const widget = result.widgets[0];
    expect(widget.type).toBe("stat-bar");
    if (widget.type === "stat-bar") {
      expect(widget.value).toBe(35);
      expect(widget.percentage).toBe(35);
    }
  });

  it("uses trigger status to hide/show component", () => {
    const blueprint: UIBlueprint = {
      version: "1.0",
      layouts: [],
      components: [
        {
          id: "night-badge",
          type: "badge",
          props: { text: "Night Shift" },
          triggerIds: ["is-night"],
        },
      ],
      bindings: [],
      triggers: [
        {
          id: "is-night",
          conditions: [{ variableId: "phase", operator: "eq", value: "night" }],
        },
      ],
      interactions: [],
    };

    const night = resolveUIBlueprint(blueprint, stateWith({ hp: 100, phase: "night", portrait: "" }), vars);
    expect(night.widgets).toHaveLength(1);
    expect(night.triggerTrace[0]?.status).toBe("active");

    const day = resolveUIBlueprint(blueprint, stateWith({ hp: 100, phase: "day", portrait: "" }), vars);
    expect(day.widgets).toHaveLength(0);
    expect(day.triggerTrace[0]?.status).toBe("inactive");
  });

  it("records an error when component references unknown trigger", () => {
    const blueprint: UIBlueprint = {
      version: "1.0",
      layouts: [],
      components: [
        {
          id: "mystery",
          type: "text",
          props: { text: "hidden" },
          triggerIds: ["missing-trigger"],
        },
      ],
      bindings: [],
      triggers: [],
      interactions: [],
    };

    const result = resolveUIBlueprint(blueprint, stateWith({ hp: 100, phase: "night", portrait: "" }), vars);
    expect(result.widgets).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("missing-trigger"))).toBe(true);
  });

  it("evaluates simple expression in trigger", () => {
    const blueprint: UIBlueprint = {
      version: "1.0",
      layouts: [],
      components: [
        {
          id: "high-hp",
          type: "text",
          props: { text: "Healthy" },
          triggerIds: ["high"],
        },
      ],
      bindings: [],
      triggers: [
        {
          id: "high",
          expression: "vars.hp >= 80 && vars.phase == 'night'",
        },
      ],
      interactions: [],
    };

    const result = resolveUIBlueprint(blueprint, stateWith({ hp: 95, phase: "night", portrait: "" }), vars);
    expect(result.widgets).toHaveLength(1);
    expect(result.triggerTrace[0]?.status).toBe("active");
  });

  it("resolves webPanel widget with html/css/js props", () => {
    const blueprint: UIBlueprint = {
      version: "1.0",
      layouts: [],
      components: [
        {
          id: "web-1",
          type: "webPanel",
          name: "Terminal Panel",
          props: {
            html: "<div id='app'>Ready</div>",
            css: "#app { color: #86efac; }",
            js: "window.__ready = true;",
            height: 240,
          },
          placement: "header",
          order: 3,
        },
      ],
      bindings: [],
      triggers: [],
      interactions: [],
    };

    const result = resolveUIBlueprint(blueprint, stateWith({ hp: 95, phase: "night", portrait: "" }), vars);
    expect(result.widgets).toHaveLength(1);
    const widget = result.widgets[0];
    expect(widget.type).toBe("web-panel");
    if (widget.type === "web-panel") {
      expect(widget.height).toBe(240);
      expect(widget.html).toContain("Ready");
    }
  });
});
