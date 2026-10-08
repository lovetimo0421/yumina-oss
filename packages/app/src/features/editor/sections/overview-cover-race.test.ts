import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual async callbacks with deferred I/O. No browser, network or
// copied implementation: navigating replaces the same global editor store.
const file = ts.createSourceFile("overview.tsx", readFileSync(new URL("./overview.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, globals: Record<string, unknown>) {
  let source = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      source = node.initializer.arguments[0]!.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(source, `Missing ${name}`);
  const code = ts.transpileModule(`globalThis.handler = ${source};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext(globals);
  vm.runInContext(code, context);
  return context.handler as (input: unknown) => Promise<void>;
}

for (const handler of ["handleCoverUpload", "handleCoverFromAsset"]) {
  for (const target of ["portrait", "landscape"]) {
    for (const navigate of [false, true]) {
      test(`${handler} ${target}: ${navigate ? "does not alter the next card" : "updates the originating card"}`, async () => {
        let resolveUpload!: (value: unknown) => void;
        const response = new Promise(resolve => { resolveUpload = resolve; });
        let current = { serverWorldId: "card-a", worldDraft: { avatar: "old-a", landscapeCover: "wide-a" } };
        const writes: Array<[string, unknown]> = [];
        const dialogs: unknown[] = [];
        const handlerFn = callback(handler, {
          serverWorldId: "card-a", coverTarget: { current: target }, apiBase: "", FROM_ASSET_TIMEOUT_MS: 20_000,
          useEditorStore: { getState: () => current },
          uploadAssetWithPresignedUrl: () => response,
          fetchWithTimeout: async () => ({ ok: true, json: async () => ({ data: await response }) }),
          setField: (key: string, value: unknown) => writes.push([key, value]),
          setCropDialog: (value: unknown) => dialogs.push(value),
          adoptOwnWriteToken() {}, setUploadingCover() {},
          setCoverError: (error: unknown) => { assert.equal(error, null); },
          getAssetUploadErrorMessage: (error: unknown) => String(error), t: (key: string) => key,
          saveDraft: () => { throw new Error("Existing card must not need a save"); },
        });
        const pending = handlerFn(handler === "handleCoverUpload" ? {} : "@asset:picture");
        if (navigate) current = { serverWorldId: "card-b", worldDraft: { avatar: "old-b", landscapeCover: "wide-b" } };
        resolveUpload({ thumbnailUrl: "uploaded-a" });
        await pending;
        if (navigate) {
          assert.deepEqual(writes, [], "a response for A must never write to B");
          assert.deepEqual(dialogs, [], "a response for A must not open a crop dialog on B");
        } else {
          assert.equal(writes[0]?.[0], target === "portrait" ? "avatar" : "landscapeCover");
          assert.equal(writes[0]?.[1], "uploaded-a");
          assert.equal(dialogs.length, 1);
        }
      });
    }
  }
}
