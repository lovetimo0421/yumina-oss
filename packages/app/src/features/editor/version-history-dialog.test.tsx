import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("versions flush layout edits and refuse snapshots of a partially saved draft", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node,
    Element: dom.window.Element, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver, NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: globalThis.fetch };
  const original = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const appRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const vite = await createServer({ root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } } });
  const root = createRoot(document.getElementById("root")!);
  try {
    const { default: i18n } = await vite.ssrLoadModule("/src/lib/i18n.ts");
    await i18n.changeLanguage("en"); await i18n.loadNamespaces(["editor", "common"]);
    const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("@/stores/editor");
    const { VersionHistoryDialog } = await vite.ssrLoadModule("/src/features/editor/version-history-dialog.tsx");
    const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(`versionHistory.${key}`, { ns: "editor", ...opts });
    const row = (over: Record<string, unknown> = {}) => ({ id: "v1", worldId: "existing", createdBy: "u1", name: "Working version",
      note: null, source: "manual", createdAt: new Date().toISOString(), ...over });
    const list = (rows: Record<string, unknown>[]) => Response.json({ data: rows, cap: 10 });
    const text = () => document.body.textContent ?? "";
    const alerts = () => [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent);
    const escape = async () => { await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })); }); };

    const calls: string[] = [];
    globalThis.fetch = async (url, init) => {
      const path = String(url);
      if (init?.method === "POST") calls.push(path.endsWith("/restore") ? "restore" : path.endsWith("/make-live") ? "live" : "snapshot");
      return list([row()]);
    };
    store.setState({ serverWorldId: "existing", isDirty: false, layoutDirty: true,
      saveDraft: async () => { calls.push("flush"); store.setState({ isDirty: false, layoutDirty: false }); return true; },
      loadWorld: async () => { calls.push("reload"); },
      refreshWorldSchema: async () => { calls.push("refresh"); } });
    let closed = 0;
    await act(async () => root.render(createElement(VersionHistoryDialog, { worldId: "existing", onClose() { closed += 1; } })));

    assert.ok(document.querySelector("div.fixed.inset-0"), "version history renders as a modal layer over the editor");
    assert.ok(text().includes(tr("title")), "the modal shows the version history");
    // Keyboard and screen-reader users get a real dialog, not just a layer
    // that happens to cover the page.
    const panel = document.querySelector('[role="dialog"]');
    assert.ok(panel, "version history is announced as a dialog");
    assert.equal(panel!.getAttribute("aria-modal"), "true");
    const labelId = panel!.getAttribute("aria-labelledby");
    assert.equal(document.getElementById(labelId!)?.textContent, tr("title"), "the dialog is named by its own heading");
    assert.ok(panel!.contains(document.activeElement), "opening the dialog moves focus into it");
    await escape();
    assert.equal(closed, 1, "the modal is dismissible from the keyboard");
    assert.ok(text().includes(tr("dirtyHint")), "a layout-only edit still counts as unsaved work");

    const click = async (key: string, last = false) => {
      const buttons = [...document.querySelectorAll("button")].filter(b => b.textContent === tr(key));
      const button = last ? buttons.at(-1) : buttons[0];
      assert.ok(button, key); await act(async () => button.click());
    };
    // The save control relabels itself while saving and just after, so find it
    // by any of the three faces it wears.
    const saveButton = () => [...document.querySelectorAll("button")].find(b => ["saveCurrent", "saving", "saved"].some(k => b.textContent === tr(k)));
    const clickSave = async () => { const button = saveButton(); assert.ok(button, "saveCurrent"); await act(async () => button.click()); };

    await clickSave();
    assert.deepEqual(calls, ["flush", "snapshot"], "layout-only edits must reach the server before the version is captured");

    calls.length = 0;
    await act(async () => store.setState({ isDirty: true, layoutDirty: false, saveDraft: async () => { calls.push("flush"); return true; } }));
    await clickSave();
    assert.deepEqual(calls, ["flush"], "a newer edit left dirty after saving must not be snapshotted as current");
    assert.equal(document.querySelector("#version-save-error")?.textContent, tr("saveFailed"), "the refusal prints next to the save control");

    calls.length = 0;
    await act(async () => store.setState({ isDirty: false, layoutDirty: true,
      saveDraft: async () => { calls.push("flush"); store.setState({ layoutDirty: false }); return true; } }));
    await click("restore");
    await escape();
    assert.equal(closed, 1, "Escape takes back the confirm, not the whole dialog");
    assert.ok(!text().includes(tr("restoreConfirmTitle")));
    await click("restore");
    assert.ok(text().includes(tr("restoreConfirmDirtyExtra")), "the confirm warns that unsaved edits go into the safety snapshot");
    await click("restoreConfirm", true);
    assert.deepEqual(calls, ["flush", "restore", "reload"], "the safety snapshot must include layout edits before restoring");

    calls.length = 0;
    globalThis.fetch = async () => { throw new Error("offline"); };
    await clickSave();
    assert.ok(saveButton() && !saveButton()!.disabled, "a network failure must leave save retryable");
    assert.equal(document.querySelector("#version-save-error")?.textContent, tr("saveFailed"));

    calls.length = 0;
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        calls.push(payload.evictOldest ? "evict" : "cap");
        return payload.evictOldest ? Response.json({ data: {} })
          : Response.json({ error: "at_cap", cap: 10, oldest: { id: "oldest", name: "Old version", createdAt: new Date().toISOString() } }, { status: 409 });
      }
      return list([row()]);
    };
    await clickSave();
    assert.ok(text().includes(tr("atCapTitle")), "a full shelf asks before evicting");
    await act(async () => store.setState({ layoutDirty: true, saveDraft: async () => { calls.push("flush"); return false; } }));
    await click("atCapConfirm", true);
    assert.deepEqual(calls, ["cap", "flush"], "capacity confirmation cannot evict a version if new layout edits fail to save");
    assert.ok(alerts().includes(tr("saveFailed")), "the failure prints inside the confirm that failed");
    assert.equal(document.querySelector("#version-save-error"), null, "and not on the form behind it");
    await act(async () => store.setState({ saveDraft: async () => { calls.push("flush"); store.setState({ layoutDirty: false }); return true; } }));
    await click("atCapConfirm", true);
    assert.deepEqual(calls, ["cap", "flush", "flush", "evict"]);

    globalThis.fetch = async () => { throw new Error("offline"); };
    await act(async () => root.render(createElement(VersionHistoryDialog, { key: "offline", worldId: "existing", onClose() { closed += 1; } })));
    assert.ok(alerts().includes(tr("loadFailed")), "a list request failure must be visible instead of appearing as no saved versions");
    assert.ok(!text().includes(tr("emptyTitle")));
    globalThis.fetch = async () => list([row({ name: "Recovered list" })]);
    await click("retry");
    assert.ok(text().includes("Recovered list"));
    assert.ok(text().includes(tr("savedListTitle", { count: 1 })));

    calls.length = 0;
    await act(async () => store.setState({ isDirty: false, layoutDirty: false }));
    let finishRestore!: (value: Response) => void;
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST") calls.push("restore");
      return new Promise<Response>(resolve => { finishRestore = resolve; });
    };
    await click("restore");
    await click("restoreConfirm", true);
    // The editor moved to another card while the restore was in flight.
    await act(async () => store.setState({ worldDraft: { ...store.getState().worldDraft, name: "Another card" } }));
    await act(async () => finishRestore(Response.json({ data: {} })));
    assert.deepEqual(calls, ["restore", "refresh"], "a restore response cannot navigate back to the old card after switching cards");
    assert.equal(store.getState().worldDraft.name, "Another card");

    const liveCalls: string[] = [];
    let liveUrl = "";
    await act(async () => store.setState({ serverWorldId: "existing", isDirty: false, layoutDirty: true, loadError: null,
      saveDraft: async () => { liveCalls.push("flush"); store.setState({ layoutDirty: false }); return true; },
      loadWorld: async () => { liveCalls.push("reload"); },
      refreshWorldSchema: async () => { liveCalls.push("refresh"); } }));
    globalThis.fetch = async (url, init) => {
      if (init?.method === "POST") { liveUrl = String(url); liveCalls.push(liveUrl.endsWith("/make-live") ? "live" : "unexpected"); }
      return list([
        row({ id: "named", name: "Working version", source: "manual" }),
        row({ id: "release-live", name: "A", source: "live", hasMetadata: true, isLive: true, canMakeLive: false,
          publishedAt: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z" }),
        row({ id: "release-a", name: "B", source: "publish", hasMetadata: true, isLive: false, canMakeLive: true,
          publishedAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z" }),
      ]);
    };
    await act(async () => root.render(createElement(VersionHistoryDialog, { key: "live", worldId: "existing", onClose() { closed += 1; } })));
    assert.ok(text().includes(tr("source.publish")), "releases are labelled by where they came from, not by their stored name");
    assert.ok(text().includes(tr("currentLive")), "the live release says so");
    assert.ok(text().includes(tr("notPublished")), "a release that is not live says so too");
    assert.ok(text().includes(tr("automaticTitle", { count: 2 })) && text().includes(tr("savedListTitle", { count: 1 })),
      "automatic records are grouped apart from named versions");
    assert.ok(text().includes(tr("capacity", { used: 1, cap: 10 })), "only named versions count against the named cap");
    assert.equal(document.querySelectorAll(`[aria-label="${tr("delete")}"]`).length, 1, "automatic records cannot be deleted by hand");
    await click("makeLive");
    assert.ok(text().includes(tr("makeLiveTitle")));
    await click("makeLive", true);
    assert.deepEqual(liveCalls, ["flush", "live", "refresh"], "switching a release first protects unsaved layout and reloads the retained draft");
    assert.equal(liveUrl, "/api/worlds/existing/versions/release-a/make-live", "the release is promoted through make-live");
    assert.ok(text().includes(tr("liveChanged")));

  } finally {
    await act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 0)); }); await vite.close(); dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
