import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { JSDOM } from "jsdom";
import ts from "typescript";
import type { Worldbook } from "@yumina/engine";

/**
 * The activation control answers "when is this module open" — a question a
 * background writer does not have. workerModules() picks workers by kind and
 * never consults the active set, and filterEntriesByActiveWorldbooks drops a
 * worker's entries from the narrator's prompt open or not (both pinned in
 * engine tests). A live dropdown here was a dial wired to nothing: an author
 * could set a keyword, watch it never matter, and have no way to learn why.
 * It only became reachable when the classic editor got a way to make a worker
 * at all — before that, workers existed only on the canvas.
 */

const book = (over: Partial<Worldbook> & { id: string }): Worldbook => ({
  name: over.id,
  activation: { mode: "always" },
  order: 0,
  ...over,
});

test("a background writer is not offered the activation it never reads", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const store = create(() => ({ worldDraft: { variables: [] } }));
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("./module-activation-editor.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  type Editor = React.FC<{ book: Worldbook; onChange: (next: Worldbook["activation"]) => void }>;
  const module = { exports: {} as { ModuleActivationEditor: Editor } };
  new Function("require", "module", "exports", js)(
    (id: string) =>
      id === "@/stores/editor" ? { useEditorStore: store }
      : id === "@/lib/utils" ? { cn: (...parts: unknown[]) => parts.filter(Boolean).join(" ") }
      : id === "./condition-editor" ? { ConditionEditor: () => null }
      : id === "lucide-react" ? { X: () => null }
      : id === "react-i18next" ? { useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }
      : require(id),
    module,
    module.exports,
  );

  const root = createRoot(dom.window.document.getElementById("root")!);
  const show = async (subject: Worldbook) => {
    await act(async () => root.render(<module.exports.ModuleActivationEditor book={subject} onChange={() => {}} />));
    return dom.window.document.body;
  };

  try {
    // Every frame gets the full picker. An AI behind the scenes too: its
    // activation is the master switch its runs check, so a chapter-two
    // recorder can be told it belongs to chapter two.
    for (const station of [undefined, { kind: "narrator" as const }, { kind: "worker" as const }]) {
      const other = await show(book({ id: "m", station }));
      const select = other.querySelector("select");
      assert.ok(select, `a ${station?.kind ?? "content"} module is asked when it is in`);
      assert.equal(select.querySelectorAll("option").length, 5);
    }

    // A worker shows the activation it has, untouched.
    const kept = book({
      id: "w",
      station: { kind: "worker" },
      activation: { mode: "keywords", keywords: ["basement"], exclusive: true },
    });
    const withKeywords = await show(kept);
    assert.equal(withKeywords.querySelector("select")?.value, "keywords");
    assert.equal(kept.activation.mode, "keywords");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
