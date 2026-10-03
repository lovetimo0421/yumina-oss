import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { resolve } from "node:path";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer, type ViteDevServer } from "vite";
import type { ToolCall } from "../lib/types";

let server: ViteDevServer;
let EntityPreview: ComponentType<{ toolCall: ToolCall }>;
const i18n = createInstance();

before(async () => {
  await i18n.init({ lng: "en", resources: { en: { editor: { studio: { entity: {
    invalidArgs: "Invalid arguments for {{name}}", write: "Write", viewFull: "View full content",
  } } } } } });
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    esbuild: { jsx: "automatic" },
    resolve: { alias: { "@/stores/editor": "virtual:preview-editor", "@": resolve(process.cwd(), "src") } },
    plugins: [{
      name: "preview-editor-fixture",
      resolveId(id) { if (id === "virtual:preview-editor") return "\0preview-editor"; },
      load(id) {
        if (id === "\0preview-editor") return `export const useEditorStore = { getState: () => ({ worldDraft: { entries: [], variables: [], rules: [], reactions: [], audioTracks: [] } }) };`;
      },
    }],
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  ({ EntityPreview } = await server.ssrLoadModule(
    "/src/features/studio/components/entity-preview.tsx",
  ));
});

after(async () => { await server?.close(); });

function call(name: string, args: unknown): ToolCall {
  return { id: "test-call", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function render(...calls: ToolCall[]) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n },
    createElement("div", null, ...calls.map((toolCall, index) => createElement(EntityPreview, { key: index, toolCall })))));
}

test("restored proxy call with object content cannot crash adjacent valid proposals", () => {
  // Production incident shape: content wraps another tool call and has no entry id.
  const bad = call("write_entry", { content: { tool_call: { name: "write_entry", arguments: { id: "lore", content: "Lore" } } } });
  const html = render(bad, call("write_entry", { id: "valid", name: "Valid entry", content: "Readable lore" }));
  assert.match(html, /Invalid arguments for write_entry/);
  assert.match(html, /Valid entry/);
  assert.match(html, /Readable lore/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

for (const args of [null, [], "text", 42, true]) {
  test(`non-object arguments (${JSON.stringify(args)}) use the existing error state`, () => {
    assert.match(render(call("write_entry", args)), /Invalid arguments for write_entry/);
  });
}

test("invalid JSON keeps the existing error state", () => {
  const broken = call("write_entry", {});
  broken.function.arguments = "{broken";
  assert.match(render(broken), /Invalid arguments for write_entry/);
});

const malformed: Array<[string, unknown]> = [
  ["write_entry", { id: "a", content: ["text"] }],
  ["write_entry", { id: "a", content: 42 }],
  ["write_entry", { name: { text: "Name" }, content: "text" }],
  ["write_entry", { id: { text: "id" }, content: "text" }],
  ["write_custom_ui", { id: "index.tsx", tsxCode: { code: "test" } }],
  ["edit_custom_ui", { id: "index.tsx", new_code: ["test"] }],
  ["write_variable", { id: "hp", behaviorRules: { text: "test" } }],
  ["delete_entities", { ids: "lore" }],
  ["delete_entities", { ids: [{ id: "lore" }] }],
  ["apply_changes", { changes: "invalid" }],
  ["apply_changes", { changes: [null] }],
];
for (const [index, [name, args]] of malformed.entries()) {
  test(`malformed proposal ${index + 1} (${name}) renders safely`, () => {
    assert.match(render(call(name, args)), new RegExp(`Invalid arguments for ${name}`));
  });
}

test("valid text still renders its summary and expand button", () => {
  const html = render(call("write_entry", { id: "lore", name: "Lore", content: "Line one\nLine two" }));
  assert.match(html, /Line one Line two/);
  assert.match(html, /title="View full content"/);
  assert.doesNotMatch(html, /Invalid arguments/);
});

test("JSON variable defaults and nested settings remain valid", () => {
  const html = render(
    call("write_variable", { id: "inventory", type: "json", defaultValue: { items: [1, 2] } }),
    call("update_settings", { structured_output: { enabled: true } }),
  );
  assert.match(html, /inventory/);
  assert.doesNotMatch(html, /Invalid arguments/);
});

test("a valid proposal still expands after an invalid proposal is replaced", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const renderCall = (toolCall: ToolCall) => createElement(I18nextProvider, { i18n }, createElement(EntityPreview, { toolCall }));
  try {
    await act(async () => { root.render(renderCall(call("write_entry", { content: { tool_call: {} } }))); });
    assert.match(container.textContent ?? "", /Invalid arguments/);
    const content = "First line\nSecond line <script>plain text</script>";
    await act(async () => { root.render(renderCall(call("write_entry", { id: "lore", content }))); });
    assert.doesNotMatch(container.textContent ?? "", /Invalid arguments/);
    const button = container.querySelector("button")!;
    assert.ok(button);
    await act(async () => { button.click(); });
    assert.equal(container.querySelector("p")?.textContent, content);
    assert.equal(container.querySelector("script"), null);
    await act(async () => { button.click(); });
    assert.equal(container.querySelector("p"), null);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
