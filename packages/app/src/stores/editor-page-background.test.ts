import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach } from "node:test";
import { createServer } from "vite";

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: key => void memory.delete(key), clear: () => memory.clear(), key: () => null, length: 0,
};
const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const { startingUiDoc } = await vite.ssrLoadModule("/src/features/studio/lib/ui-doc-takeover.ts") as typeof import("../features/studio/lib/ui-doc-takeover");
const base = structuredClone(useEditorStore.getState().worldDraft);
after(() => vite.close());
afterEach(() => { useEditorStore.getState().stopAutosave(); memory.clear(); });

const words = { strings: {}, varNames: {}, varRules: {}, openingTitle: (n: number) => `开场 ${n}` };
const rain = { kind: "image" as const, src: { kind: "asset" as const, ref: "@asset:rain" }, fit: "cover" as const, dim: 0.35 };

function withPages(backgrounds: Array<typeof rain | undefined>) {
  const doc = startingUiDoc();
  const one = doc.pages[0]!;
  const pages = backgrounds.map((bg, i) => ({ ...one, id: `p${i}`, ...(bg ? { background: bg } : {}) }));
  useEditorStore.setState({ worldDraft: { ...structuredClone(base), uiDoc: { ...doc, pages, entryPageId: "p0" } }, guestMode: false, readOnlyInspect: false, _past: [], _future: [] });
}

test("a new page puts on the picture every page already wears", () => {
  withPages([rain, rain]);
  const id = useEditorStore.getState().addPageTemplate("enter-name", words as never)!;
  const added = useEditorStore.getState().worldDraft.uiDoc!.pages.find((p) => p.id === id)!;
  assert.deepEqual(added.background, rain);
});

test("pages that differ leave the new page as its template made it", () => {
  withPages([rain, undefined]);
  const id = useEditorStore.getState().addPageTemplate("enter-name", words as never)!;
  const added = useEditorStore.getState().worldDraft.uiDoc!.pages.find((p) => p.id === id)!;
  assert.notDeepEqual(added.background, rain);
});
