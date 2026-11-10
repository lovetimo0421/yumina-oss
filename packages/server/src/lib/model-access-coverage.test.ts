import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { MODEL_ACCESS_POLICY } from "./model-access-policy.js";

/**
 * Model-access tripwire: a new AI call cannot ship without saying how it
 * respects the player's plan (see model-access-policy.ts). Before this, each
 * plugin or card feature had to remember validateModelAccess on its own, and
 * summary models, the film director and creator stations each forgot.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const productionSource = (path: string) => /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|d)\.[cm]?[jt]sx?$/.test(path);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : productionSource(full) ? [full] : [];
  });
}

/** Calls generateStream, fetches /chat/completions, or resolves a provider key. */
function reachesModel(text: string): boolean {
  const source = ts.createSourceFile("access.ts", text, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "generateStream") found = true;
      if (ts.isIdentifier(callee) && callee.text === "resolveProviderForModel") found = true;
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      && node.text.includes("/chat/completions")) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const GATE = /\b(?:validateModelAccess|planAllowedModel|planBlockReason|beginModuleGeneration|planMeetsMinimum)\s*\(/;
const rel = (path: string) => relative(SRC_ROOT, path).split(sep).join("/");
const callers = walk(SRC_ROOT).filter((path) => reachesModel(readFileSync(path, "utf8"))).map(rel).sort();

test("model detection ignores comments and finds real calls", () => {
  assert.equal(reachesModel("// provider.generateStream()\n/* resolveProviderForModel(u, m) */"), false);
  assert.equal(reachesModel("for await (const c of provider.generateStream(p)) {}"), true);
  assert.equal(reachesModel("await resolveProviderForModel(userId, model)"), true);
  assert.equal(reachesModel("fetch(`${base}/chat/completions`)"), true);
});

test("every file that reaches a model declares its model-access policy", () => {
  const missing = callers.filter((file) => !(file in MODEL_ACCESS_POLICY));
  assert.deepEqual(missing, [], `Register these in lib/model-access-policy.ts (and gate them on the player's plan): ${missing.join(", ")}`);
});

test("the registry has no stale entries", () => {
  const stale = Object.keys(MODEL_ACCESS_POLICY).filter((file) => !callers.includes(file));
  assert.deepEqual(stale, [], `No longer reach a model — remove from lib/model-access-policy.ts: ${stale.join(", ")}`);
});

test("plan-gated files still check the plan where they say they do", () => {
  for (const [file, policy] of Object.entries(MODEL_ACCESS_POLICY)) {
    if (policy.kind !== "plan-gated") continue;
    for (const gate of policy.gatedIn) {
      const path = join(SRC_ROOT, gate);
      assert.ok(existsSync(path), `${file}: gate file ${gate} does not exist`);
      assert.match(readFileSync(path, "utf8"), GATE, `${file}: ${gate} no longer checks the player's plan`);
    }
  }
});
