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
 * A worker's "when a condition holds" trigger carries its own conditions —
 * dueWorkers reads `station.trigger.conditions`, never the module's
 * activation. The console used to answer that choice with a sentence
 * pointing at the activation rule, which a worker does not show: an author
 * could pick the trigger and have nowhere to write the condition. The
 * editor lives on the trigger now, and the inputs editor sits beside the
 * trigger and the task instead of in a fold at the bottom.
 */

const book = (over: Partial<Worldbook> & { id: string }): Worldbook => ({
  name: over.id,
  activation: { mode: "always" },
  order: 0,
  ...over,
});

test("a worker's condition trigger gets a condition editor, and inputs open from the station group", async () => {
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
  const editorStore = create(() => ({ worldDraft: { variables: [{ id: "hp", name: "hp", type: "number", initial: 1 }] } }));
  const modelsStore = Object.assign(create(() => ({ models: [] as unknown[] })), {
    getState: () => ({ models: [], fetchModels: async () => {} }),
  });
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL("./module-console.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  type Console = React.FC<{ book: Worldbook; otherBooks: Worldbook[]; onChange: (patch: Partial<Worldbook>) => void }>;
  const module = { exports: {} as { ModuleConsole: Console } };
  const marker = (id: string) => () => React.createElement("div", { "data-testid": id });
  new Function("require", "module", "exports", js)(
    (id: string) =>
      id === "@/stores/editor" ? { useEditorStore: editorStore }
      : id === "@/stores/models" ? { useModelsStore: modelsStore }
      : id === "@/lib/utils" ? { cn: (...parts: unknown[]) => parts.filter(Boolean).join(" ") }
      : id === "../debounced-field" ? { DebouncedInput: () => null, DebouncedTextarea: () => null }
      : id === "./module-context-panel" ? { ModuleContextSummary: () => null, ModuleContextWires: marker("wires") }
      : id === "./memory-pool-picker" ? { MemoryPoolPicker: () => null }
      : id === "./station-activity" ? { StationActivity: () => null }
      : id === "../condition-editor" ? { ConditionEditor: marker("condition-editor") }
      : id === "../module-activation-editor" ? { LogicToggle: marker("logic-toggle") }
      : id === "lucide-react" ? { AlertTriangle: () => null }
      : id === "react-i18next" ? { useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }
      : require(id),
    module,
    module.exports,
  );

  const root = createRoot(dom.window.document.getElementById("root")!);
  const patches: Partial<Worldbook>[] = [];
  const show = async (subject: Worldbook) => {
    await act(async () =>
      root.render(<module.exports.ModuleConsole book={subject} otherBooks={[]} onChange={(p) => patches.push(p)} />),
    );
    return dom.window.document.body;
  };
  const query = (body: HTMLElement, id: string) => body.querySelector(`[data-testid="${id}"]`);

  try {
    // The trigger that needs conditions shows the editor for them.
    const conditional = await show(
      book({ id: "w", station: { kind: "worker", trigger: { on: "conditions", conditions: [] }, task: "sum up" } }),
    );
    assert.ok(query(conditional, "station-trigger-conditions"), "the conditions block renders");
    assert.ok(query(conditional, "condition-editor"), "with a condition editor inside it");
    assert.equal(query(conditional, "logic-toggle"), null, "one condition needs no all/any toggle");

    // Two conditions: the all/any toggle appears.
    const two = await show(
      book({
        id: "w",
        station: {
          kind: "worker",
          trigger: {
            on: "conditions",
            conditions: [
              { variableId: "hp", operator: "gt", value: 0 },
              { variableId: "hp", operator: "lt", value: 10 },
            ],
          },
        },
      }),
    );
    assert.ok(query(two, "logic-toggle"));

    // Any other trigger: no condition editor.
    const turns = await show(book({ id: "w", station: { kind: "worker", trigger: { on: "turns", every: 3 } } }));
    assert.equal(query(turns, "station-trigger-conditions"), null);

    // Inputs: an entry in the station group, closed by default, opening the
    // existing wires editor — and no second copy of it further down.
    const entry = query(turns, "station-inputs-entry");
    assert.ok(entry, "the inputs entry sits with the station settings");
    assert.match(entry!.textContent!, /inputsNone/);
    assert.equal(query(turns, "wires"), null);
    await act(async () => {
      (entry!.querySelector("button") as HTMLButtonElement).click();
    });
    assert.ok(query(dom.window.document.body, "wires"), "edit opens the wires editor");
    assert.equal(dom.window.document.body.querySelectorAll('[data-testid="wires"]').length, 1);

    const wired = await show(
      book({ id: "w", station: { kind: "narrator", inputs: [{ kind: "memory", from: "a" }, { kind: "memory", from: "b" }] } }),
    );
    assert.match(query(wired, "station-inputs-entry")!.textContent!, /inputsSummary/);
    assert.doesNotMatch(wired.textContent!, /blueprint\.ctx\.history/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
