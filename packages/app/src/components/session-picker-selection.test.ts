import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";
import type { SessionPickerModalProps } from "./session-picker-modal";

const saves = Array.from({ length: 3 }, (_, i) => ({
  id: `save-${i}`, name: `Save ${i}`, worldId: "world", worldName: "World",
  worldLanguage: "en", playtimeSeconds: 0, messageCount: 0,
  lastMessagePreview: null, createdAt: "2026-10-01", updatedAt: "2026-10-01",
}));

async function withPicker(run: (h: {
  checkboxes: () => HTMLInputElement[];
  button: (key: string) => HTMLButtonElement;
  click: (element: HTMLElement) => Promise<void>;
  render: (patch: Partial<SessionPickerModalProps>) => Promise<void>;
  requests: string[];
  errors: string[];
  entered: string[];
  cache: Map<string, typeof saves>;
  setFetch: (fn: typeof fetch) => void;
  dom: JSDOM;
}) => Promise<void>, count = 3) {
  const items = Array.from({ length: count }, (_, i) => ({ ...saves[i % 3]!, id: `save-${i}`, name: `Save ${i}` }));
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const errors: string[] = [];
  const entered: string[] = [];
  const cache = new Map<string, typeof saves>([["world:world", items]]);
  let fetchImpl: typeof fetch = async () => Response.json({ data: items });
  globalThis.fetch = async (input, init) => {
    if (init?.method === "DELETE") requests.push(String(input).split("/").pop()!);
    return fetchImpl(input, init);
  };
  const t = (key: string, opts?: { count?: number; name?: string }) => `${key}${opts?.count !== undefined ? `:${opts.count}` : opts?.name ? `:${opts.name}` : ""}`;
  const modules: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t, i18n: { language: "en" } }) },
    "@/stores/personas": { usePersonasStore: create(() => ({ savingSelection: false, selectionFailed: false })) },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "user" } } }) },
    "@/lib/session-picker-cache": { getCachedSessions: (_: string, key: string) => cache.get(key), setCachedSessions: (_: string, key: string, value: typeof saves) => cache.set(key, value) },
    "@/lib/feedback": { feedback: { error: (text: string) => errors.push(text) } },
    "@/lib/playtime": { formatPlaytimeHours: () => "0 h", formatPlaytimeShort: () => "0h" },
    "@/lib/format-time": { formatTimeAgo: () => "today" },
    "@/lib/languages": { LANGUAGE_SHORT: {}, variantRowLabels: () => new Map() },
    "@/components/session-modal-styles": {},
    "@/features/chat/world-persona-menu": { WorldPersonaIconMenu: () => null },
    "@/components/version-picker-modal": { soleCurrentLanguageVariant: () => null },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { SessionPickerModal: ComponentType<SessionPickerModalProps> } };
  const source = readFileSync(new URL("./session-picker-modal.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => modules[id] ?? require(id), module, module.exports);
  const root = createRoot(document.getElementById("root")!);
  let props: SessionPickerModalProps = { open: true, onClose() {}, onSelectSession: (id) => entered.push(id), onCreateSession() {}, world: { id: "world", name: "World" }, variants: [] };
  const render = async (patch: Partial<SessionPickerModalProps>) => {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(module.exports.SessionPickerModal, props)));
  };
  try {
    await render({});
    await run({ dom, render, requests, errors, entered, cache,
      checkboxes: () => {
        const all = document.querySelector<HTMLInputElement>('[aria-label="header.selectAllSessions"]');
        const rows = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter((el) => el !== all);
        return all ? [all, ...rows] : rows;
      },
      button: (key) => {
        const found = Array.from(document.querySelectorAll("button")).find((el) => el.textContent?.startsWith(key));
        assert.ok(found, `Missing button ${key}`);
        return found;
      },
      click: async (element) => { await act(async () => element.click()); },
      setFetch: (fn) => { fetchImpl = fn; },
    });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("Select enters selection mode without replacing the original menu or session rows", async () => {
  await withPicker(async (h) => {
    assert.equal(h.checkboxes().length, 0);
    assert.ok(h.button("header.newSession"));
    const dialog = document.querySelector('[role="dialog"]')!;
    const layout = Array.from(dialog.children);
    assert.equal(layout.length, 5);
    const row = Array.from(document.querySelectorAll("span")).find((el) => el.textContent === "Save 0")!.closest(".group") as HTMLElement;
    const details = row.children[1];
    await h.click(row);
    assert.deepEqual(h.entered, ["save-0"]);
    await h.click(h.button("header.selectSessions"));
    assert.deepEqual(Array.from(dialog.children), layout);
    assert.equal(h.checkboxes()[1]!.closest(".group"), row);
    assert.equal(row.children[1], details);
    assert.equal(row.querySelector("label")!.classList.contains("h-7"), true);
    // Even with nothing selected, a row click selects instead of entering chat.
    await h.click(row);
    assert.deepEqual(h.entered, ["save-0"]);
    assert.equal(h.checkboxes()[1]!.checked, true);
    await h.click(row);
    const firstCheckbox = h.checkboxes()[1]!;
    firstCheckbox.focus();
    await h.click(firstCheckbox);
    assert.equal(document.activeElement, firstCheckbox);
    assert.equal(h.checkboxes()[0]!.indeterminate, true);
    assert.equal(h.button("header.deleteSelectedSessions").textContent, "header.deleteSelectedSessions:1");
    await h.click(h.checkboxes()[0]!);
    assert.ok(h.checkboxes().every((el) => el.checked));
    await h.click(h.checkboxes()[2]!);
    assert.equal(h.checkboxes()[0]!.indeterminate, true);
    await h.click(h.checkboxes()[0]!);
    await h.click(h.checkboxes()[0]!);
    assert.ok(h.checkboxes().every((el) => !el.checked));
    await h.click(row);
    await h.click(h.button("header.finishSelectingSessions"));
    assert.equal(h.checkboxes().length, 0);
    assert.ok(h.button("header.newSession"));
    assert.deepEqual(Array.from(dialog.children), layout);
    await h.click(row);
    assert.deepEqual(h.entered, ["save-0", "save-0"]);
  });
});

test("bulk delete requires confirmation, supports cancel, and updates the cached list", async () => {
  await withPicker(async (h) => {
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[0]!);
    await h.click(h.button("header.deleteSelectedSessions"));
    assert.deepEqual(h.requests, []);
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /bulkDeleteConfirm:3/);
    await h.click(h.button("common:action.cancel"));
    assert.deepEqual(h.requests, []);
    await h.click(h.button("header.deleteSelectedSessions"));
    await h.click(h.button("common:action.delete"));
    assert.deepEqual(h.requests.sort(), ["save-0", "save-1", "save-2"]);
    assert.equal(h.checkboxes().length, 0);
    assert.deepEqual(h.cache.get("world:world"), []);
    await h.render({ open: false });
    h.setFetch(async () => { throw new Error("offline"); });
    await h.render({ open: true });
    assert.equal(h.checkboxes().length, 0);
  });
});

test("successful deletion exits selection mode so remaining sessions can be played immediately", async () => {
  await withPicker(async (h) => {
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[1]!);
    await h.click(h.button("header.deleteSelectedSessions"));
    await h.click(h.button("common:action.delete"));
    assert.deepEqual(h.requests, ["save-0"]);
    assert.equal(h.checkboxes().length, 0);
    assert.ok(h.button("header.selectSessions"));
    assert.ok(h.button("header.newSession"));
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.deepEqual(h.cache.get("world:world")!.map((s) => s.id), ["save-1", "save-2"]);
    const row = Array.from(document.querySelectorAll("span")).find((el) => el.textContent === "Save 1")!.closest(".group") as HTMLElement;
    await h.click(row);
    assert.deepEqual(h.entered, ["save-1"]);
  });
});

test("partial HTTP and network failures stay selected for retry; already deleted saves are removed", async () => {
  await withPicker(async (h) => {
    h.setFetch(async (url) => {
      if (String(url).endsWith("save-0")) return new Response(null, { status: 404 });
      if (String(url).endsWith("save-1")) return new Response(null, { status: 500 });
      throw new Error("offline");
    });
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[0]!);
    await h.click(h.button("header.deleteSelectedSessions"));
    await h.click(h.button("common:action.delete"));
    assert.equal(h.checkboxes().length, 3);
    assert.ok(h.checkboxes().every((el) => el.checked));
    assert.deepEqual(h.errors, ["header.bulkDeleteFailed:2"]);
    assert.deepEqual(h.cache.get("world:world")!.map((s) => s.id), ["save-1", "save-2"]);
    h.setFetch(async () => new Response(null, { status: 200 }));
    await h.click(h.button("header.deleteSelectedSessions"));
    await h.click(h.button("common:action.delete"));
    assert.deepEqual(h.requests, ["save-0", "save-1", "save-2", "save-1", "save-2"]);
    assert.equal(h.checkboxes().length, 0);
  });
});

test("rapid confirmation clicks submit once and block closing or entering while deleting", async () => {
  await withPicker(async (h) => {
    let closed = 0;
    await h.render({ onClose: () => { closed += 1; } });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    h.setFetch(async () => { await pending; return new Response(null, { status: 200 }); });
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[0]!);
    await h.click(h.button("header.deleteSelectedSessions"));
    const confirm = h.button("common:action.delete");
    await act(async () => { confirm.click(); confirm.click(); });
    assert.equal(h.requests.length, 3);
    assert.ok(h.checkboxes().every((el) => el.disabled));
    assert.equal(h.button("header.finishSelectingSessions").disabled, true);
    await act(async () => document.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    await h.click(document.querySelector<HTMLButtonElement>('[aria-label="common:action.close"]')!);
    await h.click(document.querySelector('[role="dialog"]')!.previousElementSibling as HTMLElement);
    assert.equal(closed, 0);
    await h.click(h.checkboxes()[1]!.closest(".group") as HTMLElement);
    assert.deepEqual(h.entered, []);
    await act(async () => release());
    assert.equal(h.checkboxes().length, 0);
  });
});

for (const mode of ["bulk", "single"] as const) {
  test(`${mode} deletion ignores a stale background refresh`, async () => {
    await withPicker(async (h) => {
      let respond!: (response: Response) => void;
      let signal: AbortSignal | null | undefined;
      h.setFetch(async (_, init) => {
        if (init?.method === "DELETE") return new Response(null, { status: 200 });
        signal = init?.signal;
        return new Promise<Response>((resolve) => { respond = resolve; });
      });
      await h.render({ open: false });
      await h.render({ open: true });
      if (mode === "bulk") {
        await h.click(h.button("header.selectSessions"));
        await h.click(h.checkboxes()[0]!);
        await h.click(h.button("header.deleteSelectedSessions"));
        await h.click(h.button("common:action.delete"));
      } else {
        await h.click(document.querySelector<HTMLButtonElement>('[aria-label="header.deleteSession"]')!);
        await h.click(h.button("header.yes"));
      }
      assert.equal(signal?.aborted, true);
      await act(async () => respond(Response.json({ data: saves })));
      assert.equal(h.cache.get("world:world")!.length, mode === "bulk" ? 0 : 2);
      assert.equal(h.checkboxes().length, 0);
    });
  });
}

test("an old deletion does not replace a different world's rows or show its failure there", async () => {
  await withPicker(async (h) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    h.setFetch(async (_, init) => {
      if (init?.method === "DELETE") { await pending; return new Response(null, { status: 500 }); }
      return Response.json({ data: [{ ...saves[0], id: "other-save", name: "Other save", worldId: "other" }] });
    });
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[0]!);
    await h.click(h.button("header.deleteSelectedSessions"));
    await h.click(h.button("common:action.delete"));
    await h.render({ world: { id: "other", name: "Other" } });
    await act(async () => release());
    assert.equal(h.checkboxes().length, 0);
    assert.ok(h.button("header.selectSessions"));
    assert.match(document.body.textContent!, /Other save/);
    assert.ok(h.checkboxes().every((el) => !el.checked));
    assert.deepEqual(h.errors, []);
  });
});

test("a failed in-flight rename defers its refresh until bulk deletion finishes", async () => {
  await withPicker(async (h) => {
    let failRename!: () => void;
    let finishDelete!: () => void;
    const rename = new Promise<void>((resolve) => { failRename = resolve; });
    const deletion = new Promise<void>((resolve) => { finishDelete = resolve; });
    let refreshes = 0;
    h.setFetch(async (_, init) => {
      if (init?.method === "PATCH") { await rename; throw new Error("rename failed"); }
      if (init?.method === "DELETE") { await deletion; return new Response(null, { status: 200 }); }
      refreshes += 1;
      return Response.json({ data: [] });
    });
    await h.click(document.querySelector<HTMLButtonElement>('[aria-label="header.renameSession"]')!);
    await h.click(document.querySelector<HTMLInputElement>('input[maxlength="100"]')!.parentElement!.querySelector("button")!);
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[0]!);
    await h.click(h.button("header.deleteSelectedSessions"));
    await h.click(h.button("common:action.delete"));
    await act(async () => failRename());
    assert.equal(refreshes, 0);
    await act(async () => finishDelete());
    assert.equal(refreshes, 1);
    assert.equal(h.checkboxes().length, 0);
    assert.deepEqual(h.cache.get("world:world"), []);
  });
});

test("Escape cancels confirmation then selection; reopening resets selection", async () => {
  await withPicker(async (h) => {
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[0]!);
    await h.click(h.button("header.deleteSelectedSessions"));
    await act(async () => document.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.ok(h.checkboxes()[0]!.checked);
    await act(async () => document.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(h.checkboxes().length, 0);
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[1]!);
    await h.render({ open: false });
    await h.render({ open: true });
    assert.ok(h.checkboxes().every((el) => !el.checked));
  });
});

test("select all deletes large lists with at most four concurrent requests", async () => {
  await withPicker(async (h) => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    h.setFetch(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      completed += 1;
      if (completed === 9) finish();
      return new Response(null, { status: 200 });
    });
    await h.click(h.button("header.selectSessions"));
    await h.click(h.checkboxes()[0]!);
    await h.click(h.button("header.deleteSelectedSessions"));
    await h.click(h.button("common:action.delete"));
    await act(async () => { await finished; });
    assert.equal(h.requests.length, 9);
    assert.equal(peak, 4);
    assert.equal(h.checkboxes().length, 0);
  }, 9);
});

test("empty list has no select-all or delete controls", async () => {
  await withPicker(async (h) => {
    assert.equal(h.checkboxes().length, 0);
    assert.match(document.body.textContent!, /header.noSessions/);
  }, 0);
});
