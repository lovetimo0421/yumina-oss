import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("leave guard reads current state: saved/confirmed deleted drafts can navigate before React rerenders", () => {
  const source = readFileSync(new URL("./use-unsaved-changes-guard.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  // Capture the options registered with the router, then call the production
  // decision callbacks exactly when history or beforeunload asks for them.
  const module = { exports: {} as { useUnsavedChangesGuard: (dirty: boolean, options?: object) => { shouldBlockFn: () => boolean; enableBeforeUnload: () => boolean; disabled: boolean } } };
  new Function("require", "exports", compiled)(() => ({ useBlocker: (options: unknown) => options }), module.exports);
  let dirty = true;
  let backups = 0;
  const guard = module.exports.useUnsavedChangesGuard(true, { getIsDirty: () => dirty, beforeLeave: () => { backups++; } });
  assert.equal(guard.shouldBlockFn(), true, "an unsaved variant/front-end switch must be blocked");
  assert.equal(guard.enableBeforeUnload(), true);
  assert.equal(backups, 2);
  dirty = false; // save or successful delete completes before React has rendered
  assert.equal(guard.shouldBlockFn(), false);
  assert.equal(guard.enableBeforeUnload(), false);
  assert.equal(backups, 2);
  dirty = true; // another edit after a successful save must still be protected
  assert.equal(guard.disabled, false);
  assert.equal(guard.shouldBlockFn(), true);
  const unchangedCaller = module.exports.useUnsavedChangesGuard(false);
  assert.equal(unchangedCaller.disabled, true);
});
