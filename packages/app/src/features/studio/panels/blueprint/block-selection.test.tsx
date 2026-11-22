import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlow } from "@xyflow/react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { BlockNodeData, BlockRowView } from "./block-node";

const vite = await createServer({ configFile: false, resolve: { alias: { "@": fileURLToPath(new URL("../../../..", import.meta.url)) } }, esbuild: { jsx: "automatic" }, root: fileURLToPath(new URL("../../../../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { BlockNode } = await vite.ssrLoadModule("/src/features/studio/panels/blueprint/block-node.tsx") as typeof import("./block-node");
after(() => vite.close());

const selectionShadow = "shadow-[inset_3px_0_0_#f0c674,inset_0_0_0_1px_rgba(240,198,116,0.5)]";
const cases = [
  ["state", "variable", "var"], ["behavior", "rule", "rule"],
  ["audio", "audio", "audio"], ["image", "image", "image"],
  ["opening", "greeting", "greeting"], ["lore", "entry", "entry"],
] as const;

for (const [blockKind, kind, prefix] of cases) {
  test(`${kind} selection surrounds its expanded editor and slots, without selecting neighbors`, () => {
    const rows: BlockRowView[] = ["first", "second"].map(id => ({
      g: { id: `${prefix}:${id}`, kind, title: id, ports: [], data: {} },
      title: id, hasIn: false, hasOut: false,
      slots: blockKind === "lore" ? [] : [{ portId: "slot", label: `Slot ${id}` }],
    }));
    const first = rows[0]!.g.id;
    const second = rows[1]!.g.id;
    const noop = () => {};
    const initial: BlockNodeData = {
      block: { id: `block:${blockKind}`, kind: blockKind, headSlots: [], rows, hiddenCount: 0, total: 2, sharedCount: 0 },
      rows, title: blockKind, collapsed: false, expanded: false, hiddenCount: 0,
      emptyLabel: "Empty", readOnly: false, width: 900,
      expandedIds: new Set([first]),
      renderEditor: id => createElement("textarea", { "data-test-editor": id }),
      onToggleRowExpand: noop, onToggleCollapse: noop, onToggleExpand: noop, onExpandRows: noop,
      onRenameRow: noop, onRowClick: noop, onRowHover: noop, onRowDoubleClick: noop, onRowContextMenu: noop,
    };
    for (const multi of [false, true]) {
      for (const expanded of [false, true]) {
        const data = { ...initial, expandedIds: new Set(expanded ? [first] : []), selectedId: multi ? null : first, multiSelected: multi ? new Set([first]) : null };
        const html = renderToStaticMarkup(createElement(ReactFlow, {
          nodes: [{ id: "block", type: "block", data, position: { x: 0, y: 0 }, width: 900, height: 1000 }],
          edges: [], nodeTypes: { block: BlockNode }, width: 900, height: 1200,
        }));
        const dom = new JSDOM(html);
        try {
          const doc = dom.window.document;
          const header = doc.querySelector(`[data-row-anchor="${first}"]`)!;
          const neighbor = doc.querySelector(`[data-row-anchor="${second}"]`)!;
          const highlight = [...doc.querySelectorAll<HTMLElement>("[class]")].find(el => el.classList.contains(selectionShadow));
          // A row open alone is being written in: the open editor says so,
          // and the gold wash over it is gone. One of several picked keeps it.
          if (expanded && !multi) {
            assert.equal(Boolean(highlight), false, "a row open for writing is not washed gold");
            assert.equal(header.querySelectorAll("input").length, 1, "the expanded header becomes the one name field");
            assert.ok(doc.querySelector(`[data-row-editor="${first}"]`));
            continue;
          }
          assert.ok(highlight, "selected item has a visible outline, including lore with a separator shadow");
          assert.ok(highlight.contains(header));
          assert.ok(!highlight.contains(neighbor), "selection must not surround the whole list");
          assert.equal((header as HTMLElement).style.height, blockKind === "lore" ? "68px" : "30px", "row handle/anchor geometry stays on the header");
          assert.equal(header.querySelectorAll("input").length, expanded ? 1 : 0, "the expanded header becomes the one name field");
          const editor = doc.querySelector(`[data-row-editor="${first}"]`);
          if (expanded) {
            assert.ok(editor);
            assert.ok(highlight.contains(editor), "highlight includes the complete expanded editor");
          } else assert.equal(editor, null);
          if (blockKind !== "lore") assert.ok(highlight.textContent?.includes("Slot first"), "connection slots belong to the selected item");
        } finally { dom.window.close(); }
      }
    }
    const phoneMarkup = renderToStaticMarkup(createElement(ReactFlow, {
      nodes: [{ id: "block", type: "block", data: { ...initial, renderEditor: undefined }, position: { x: 0, y: 0 }, width: 900, height: 1000 }],
      edges: [], nodeTypes: { block: BlockNode }, width: 900, height: 1200,
    }));
    const phoneDom = new JSDOM(phoneMarkup);
    try {
      assert.equal(phoneDom.window.document.querySelector("[data-row-name], [data-row-editor]"), null,
        "phone tiles keep names as labels and use their existing editor page, even with a retained expanded id");
    } finally { phoneDom.window.close(); }
  });
}

test("variable, audio and scene image rows carry the row menu's ⋯; read-only boards do not", () => {
  const noop = () => {};
  for (const [blockKind, kind, prefix] of [["state", "variable", "var"], ["audio", "audio", "audio"], ["image", "image", "image"]] as const) {
    const rows: BlockRowView[] = [{ g: { id: `${prefix}:one`, kind, title: "one", ports: [], data: {} }, title: "one", hasIn: false, hasOut: false, slots: [] }];
    const base: BlockNodeData = {
      block: { id: `block:${blockKind}`, kind: blockKind, headSlots: [], rows, hiddenCount: 0, total: 1, sharedCount: 0 },
      rows, title: blockKind, collapsed: false, expanded: false, hiddenCount: 0,
      emptyLabel: "Empty", readOnly: false, width: 900,
      onToggleCollapse: noop, onToggleExpand: noop, onExpandRows: noop,
      onRowClick: noop, onRowHover: noop, onRowDoubleClick: noop, onRowContextMenu: noop,
    };
    const render = (data: BlockNodeData) => renderToStaticMarkup(createElement(ReactFlow, {
      nodes: [{ id: "block", type: "block", data, position: { x: 0, y: 0 }, width: 900, height: 1000 }],
      edges: [], nodeTypes: { block: BlockNode }, width: 900, height: 1200,
    }));
    assert.equal(render(base).includes(`data-row-more="${prefix}:one"`), true, `${kind} row has a ⋯`);
    assert.equal(render({ ...base, readOnly: true }).includes("data-row-more"), false, `read-only ${kind} row has no ⋯`);
  }
});
