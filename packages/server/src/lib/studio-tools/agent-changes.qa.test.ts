/**
 * QA for the 2026-06-02 agent changes (branch feat/studio-agent-opencode-edit-validate):
 *   1. Preload trim (context-resolver)  — the behavior-changing, regression-risk one.
 *   2. Edit cascade (edit_custom_ui)     — end-to-end through executeApplyChanges.
 *   3. skipTsx on executeValidateWorld   — the auto-validate-after-write building block.
 *
 * Drives the REAL functions with fixtures that reproduce the production scenarios
 * (incl. czh123's world: a huge single rootComponent file + a non-UI request).
 * Deterministic — no LLM, no server; loadUserAssets is try/caught to [].
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { resolveContext } from "./context-resolver.js";
import { executeApplyChanges, executeValidateWorld } from "./tool-executor.js";

// ── fixtures ──

function makeWorld(
  files: Record<string, string>,
  opts: { entries?: unknown[]; variables?: unknown[]; reactions?: unknown[] } = {},
): WorldDefinition {
  return {
    id: "qa-world",
    name: "QA World",
    description: "fixture",
    version: "20.0.0",
    entries: opts.entries ?? [],
    variables: opts.variables ?? [],
    rules: [],
    reactions: opts.reactions ?? [],
    audioTracks: [],
    customUI: [],
    settings: {},
    rootComponent: {
      id: "root-component",
      name: "App",
      entryFile: "index.tsx",
      files,
      updatedAt: new Date(0).toISOString(),
    },
  } as unknown as WorldDefinition;
}

const BIG = `// ${"x".repeat(50000)} __MARK_BIG__\nexport default function App(){ return null; }`; // ~50KB, > 32KB cap
const SMALL = `export default function Bubble(){ return <div>__MARK_SMALL__</div>; }`;        // < 32KB
const FAKE_USER = "qa-fake-user-no-assets";
const opts = { userId: FAKE_USER, contextWindow: 600_000 }; // Sonnet budget → 270K preload budget

// ── 1. Preload trim (the czh123 regression-risk path) ──

test("preload: NON-UI request on a huge-file world does NOT dump the big file (czh123 repro)", async () => {
  const world = makeWorld({ "index.tsx": BIG });
  const ctx = await resolveContext(world, "add a variable for player health and a quest behavior", opts);
  assert.ok(!ctx.preloadedEntities.includes("__MARK_BIG__"), "big file must NOT be preloaded for a non-UI request");
  // ...but the agent can still find it: inventory lists it with size + a read hint.
  assert.match(ctx.inventory, /index\.tsx.*\[\d+KB\]/, "inventory lists the file with its size");
  assert.match(ctx.inventory, /large; read on demand/, "inventory hints to read the big file on demand");
  assert.ok(ctx.tokenEstimate < 40_000, `prompt stays small (was ~200K in prod); got ${ctx.tokenEstimate} tokens`);
});

test("preload: even a UI request never force-dumps a >32KB file", async () => {
  const world = makeWorld({ "index.tsx": BIG });
  const ctx = await resolveContext(world, "change the interface component styling", opts);
  assert.ok(!ctx.preloadedEntities.includes("__MARK_BIG__"), "big file excluded by the 32KB cap even on a UI request");
  assert.match(ctx.inventory, /large; read on demand/);
});

test("preload: small UI files STILL preload on a UI request (no regression for the common case)", async () => {
  const world = makeWorld({ "bubble.tsx": SMALL });
  const ctx = await resolveContext(world, "update the interface component layout", opts);
  assert.ok(ctx.preloadedEntities.includes("__MARK_SMALL__"), "small UI file should be preloaded on a UI request");
});

test("preload: mixed sizes on a UI request → small in, big out", async () => {
  const world = makeWorld({ "bubble.tsx": SMALL, "huge.tsx": BIG });
  const ctx = await resolveContext(world, "redesign the ui component and its interface", opts);
  assert.ok(ctx.preloadedEntities.includes("__MARK_SMALL__"), "small file preloaded");
  assert.ok(!ctx.preloadedEntities.includes("__MARK_BIG__"), "big file not preloaded");
});

test("preload: inventory always lists files with sizes, regardless of request type", async () => {
  const world = makeWorld({ "bubble.tsx": SMALL });
  const ctx = await resolveContext(world, "tell me about this world", opts);
  assert.match(ctx.inventory, /bubble\.tsx.*\[\d+KB\]/);
});

// ── 2. Edit cascade end-to-end (executeApplyChanges → applyEditCustomUI) ──

function editChange(id: string, old_code: string, new_code: string) {
  return [{ action: "update" as const, entityType: "customUI" as const, id, data: { old_code, new_code } }];
}

test("edit: exact unique match applies (no regression on the common path)", () => {
  const world = makeWorld({ "index.tsx": "export default function App(){\n  const x = 1;\n  return <div>{x}</div>;\n}" });
  const res = executeApplyChanges(world, editChange("index.tsx", "const x = 1;", "const x = 2;"));
  assert.equal(res.success, true);
  assert.match(res.world.rootComponent!.files["index.tsx"]!, /const x = 2;/);
});

test("edit: indentation-drifted multi-line block still applies (cascade rescue)", () => {
  const world = makeWorld({
    "index.tsx": "export default function App(){\n        const greeting = \"hi\";\n        return <div>{greeting}</div>;\n}",
  });
  // model reproduced the block with shallow indent (exact match would fail)
  const res = executeApplyChanges(world, editChange(
    "index.tsx",
    "const greeting = \"hi\";\n  return <div>{greeting}</div>;",
    "const greeting = \"hello\";\n  return <div>{greeting}</div>;",
  ));
  assert.equal(res.success, true, res.summary);
  assert.match(res.world.rootComponent!.files["index.tsx"]!, /hello/);
});

test("edit: ambiguous old_code is REJECTED, never silently mis-edited", () => {
  const world = makeWorld({ "index.tsx": "function App(){\n  foo();\n  foo();\n  return null;\n}" });
  const res = executeApplyChanges(world, editChange("index.tsx", "foo();", "bar();"));
  assert.equal(res.success, false);
  assert.match(res.results[0]!.error ?? "", /appears 2 times|not unique/i);
});

test("edit: not-found old_code returns an error with a closest-region hint", () => {
  const world = makeWorld({ "index.tsx": "export default function App(){ return <div>hello</div>; }" });
  const res = executeApplyChanges(world, editChange("index.tsx", "const totallyAbsent = 999;", "const x = 1;"));
  assert.equal(res.success, false);
  assert.match(res.results[0]!.error ?? "", /not found/i);
});

test("edit: a change that breaks TSX syntax is rejected (compileTsx guard holds)", () => {
  const world = makeWorld({ "index.tsx": "export default function App(){\n  const x = 1;\n  return <div>{x}</div>;\n}" });
  // drop the function's closing brace
  const res = executeApplyChanges(world, editChange("index.tsx", "return <div>{x}</div>;\n}", "return <div>{x}</div>;"));
  assert.equal(res.success, false);
  assert.match(res.results[0]!.error ?? "", /invalid TSX|TSX/i);
});

test("edit: replacing a middle line preserves the surrounding lines (no newline-swallow)", () => {
  const world = makeWorld({ "index.tsx": "export default function App(){\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return <div>{a+b+c}</div>;\n}" });
  const res = executeApplyChanges(world, editChange("index.tsx", "const b = 2;", "const b = 20;"));
  assert.equal(res.success, true, res.summary);
  const out = res.world.rootComponent!.files["index.tsx"]!;
  assert.match(out, /const a = 1;\n  const b = 20;\n  const c = 3;/);
});

// ── 3. executeValidateWorld(skipTsx) — the auto-validate building block ──

test("validate: skipTsx keeps structural checks but drops the TSX syntax scan", () => {
  const world = makeWorld(
    { "index.tsx": "export default function App() { return <div> ;" }, // broken TSX
    {
      entries: [{ id: "dup", name: "E", section: "chat-history", role: "chat-history", content: "hello", keywords: ["k"], conditions: [], enabled: true }],
      variables: [{ id: "dup", name: "V", type: "number", defaultValue: 0, behaviorRules: "n/a" }],
    },
  );

  const full = executeValidateWorld(world);
  const fullCodes = full.issues.map((i) => i.code);
  assert.ok(fullCodes.includes("tsx-syntax-error"), "full validate catches the broken TSX");
  assert.ok(fullCodes.includes("duplicate-id-cross-type"), "full validate catches the structural error");

  const skipped = executeValidateWorld(world, { skipTsx: true });
  const skipCodes = skipped.issues.map((i) => i.code);
  assert.ok(!skipCodes.includes("tsx-syntax-error"), "skipTsx drops the TSX scan");
  assert.ok(skipCodes.includes("duplicate-id-cross-type"), "skipTsx keeps the cheap structural check");
});

test("validate: a clean world reports clean under both modes", () => {
  const world = makeWorld({ "index.tsx": "export default function App(){ return <div>ok</div>; }" });
  assert.equal(executeValidateWorld(world).issues.filter((i) => i.severity === "error").length, 0);
  assert.equal(executeValidateWorld(world, { skipTsx: true }).issues.filter((i) => i.severity === "error").length, 0);
});
