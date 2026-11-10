import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { WorldDefinition } from "@yumina/engine";
import { useAiFocus } from "./ai-focus";
import { useEditorFocus } from "./use-editor-focus";

const world = {
  entries: [{ id: "e1", name: "开场白", content: "雾很浓。", role: "greeting" }],
  variables: [{ id: "hp", name: "体力" }, { id: "mp", name: "法力" }],
  reactions: [{ id: "r1", name: "受伤" }],
} as unknown as WorldDefinition;

function Section({ kind, id }: { kind: "entry" | "variable" | "reaction"; id: string | null }) {
  useEditorFocus(kind, id, world);
  return null;
}

test("the item open in a full-editor section is what the assistant is pointed at", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const ids = () => useAiFocus.getState().items.map((item) => item.id);
  try {
    useAiFocus.getState().clear();
    // A section opening its first variable by itself is not pointing at it.
    await act(async () => root.render(<Section kind="variable" id="hp" />));
    assert.deepEqual(ids(), []);
    await act(async () => root.render(<Section kind="variable" id="mp" />));
    assert.deepEqual(ids(), ["var:mp"]);
    // Going back to the first one now counts — the creator picked it.
    await act(async () => root.render(<Section kind="variable" id="hp" />));
    assert.deepEqual(ids(), ["var:hp"]);
    assert.equal(useAiFocus.getState().items[0]!.title, "体力");

    // Leaving the section takes its item away; the lorebook opens with
    // nothing selected, so the first entry clicked counts straight away.
    await act(async () => root.render(<Section key="lore" kind="entry" id={null} />));
    assert.deepEqual(ids(), []);
    await act(async () => root.render(<Section key="lore" kind="entry" id="e1" />));
    assert.deepEqual(ids(), ["entry:e1"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

test("closing a section does not wipe a selection the canvas made since", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    useAiFocus.getState().clear();
    await act(async () => root.render(<Section kind="reaction" id={null} />));
    await act(async () => root.render(<Section kind="reaction" id="r1" />));
    assert.deepEqual(useAiFocus.getState().items.map((i) => i.id), ["reaction:r1"]);
    useAiFocus.getState().setFromCanvas([{ id: "block:frontend", kind: "frontend", title: "界面", size: 10 }]);
    await act(async () => root.unmount());
    assert.deepEqual(useAiFocus.getState().items.map((i) => i.id), ["block:frontend"]);
  } finally {
    dom.window.close();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});
