import { describe, it, expect } from "vitest";
import { preserveSetupScopedVariables } from "../state/setup-scope.js";
import type { GameState, Variable } from "../types/index.js";

function v(id: string, scope?: "narrative" | "setup"): Variable {
  return { id, name: id, type: "json", defaultValue: "[]", scope };
}

function state(vars: Record<string, unknown>): GameState {
  return { worldId: "t", variables: vars, turnCount: 0, metadata: {} };
}

describe("preserveSetupScopedVariables", () => {
  const vars = [v("selected-members", "setup"), v("hp"), v("mood", "narrative")];

  it("carries a setup-scoped variable from current state over the incoming snapshot", () => {
    const current = state({ "selected-members": ["Chan", "Lee Know"], hp: 5 });
    const next = state({ "selected-members": [], hp: 10 }); // opening snapshot = defaults
    const out = preserveSetupScopedVariables(vars, current, next);
    expect(out.variables["selected-members"]).toEqual(["Chan", "Lee Know"]); // player choice survives
    expect(out.variables.hp).toBe(10); // narrative var follows the snapshot
  });

  it("does NOT preserve narrative-scoped or default-scoped variables", () => {
    const current = state({ hp: 5, mood: "happy" });
    const next = state({ hp: 10, mood: "sad" });
    const out = preserveSetupScopedVariables(vars, current, next);
    expect(out.variables.hp).toBe(10);
    expect(out.variables.mood).toBe("sad");
  });

  it("never injects undefined when the setup var is absent from current state", () => {
    const current = state({ hp: 5 }); // no selected-members yet
    const next = state({ "selected-members": [], hp: 10 });
    const out = preserveSetupScopedVariables(vars, current, next);
    expect(out.variables["selected-members"]).toEqual([]);
    expect("selected-members" in out.variables).toBe(true);
  });

  it("is a no-op (returns same ref) when the world declares no setup-scoped vars", () => {
    const next = state({ hp: 10 });
    const out = preserveSetupScopedVariables([v("hp"), v("mood")], state({ hp: 5 }), next);
    expect(out).toBe(next);
  });

  it("does not mutate the input states", () => {
    const current = state({ "selected-members": ["Chan"] });
    const next = state({ "selected-members": [] });
    const nextVarsRef = next.variables;
    preserveSetupScopedVariables(vars, current, next);
    expect(next.variables).toBe(nextVarsRef);
    expect(next.variables["selected-members"]).toEqual([]);
    expect(current.variables["selected-members"]).toEqual(["Chan"]);
  });

  it("tolerates null/undefined current state", () => {
    const next = state({ "selected-members": [] });
    expect(preserveSetupScopedVariables(vars, null, next).variables["selected-members"]).toEqual([]);
    expect(preserveSetupScopedVariables(vars, undefined, next).variables["selected-members"]).toEqual([]);
  });

  it("works on raw server-style state records (no GameState typing)", () => {
    const current = { variables: { "selected-members": ["Han"] } };
    const next = { variables: { "selected-members": [] }, turnCount: 0 };
    const out = preserveSetupScopedVariables(vars, current, next);
    expect(out.variables["selected-members"]).toEqual(["Han"]);
  });
});
