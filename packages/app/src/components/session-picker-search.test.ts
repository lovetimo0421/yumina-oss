import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";
import type { SessionPickerModalProps } from "./session-picker-modal";

// The save picker's search, sort, pins and "select all matching", with the
// list and search endpoints answered in memory.
const saves = [
  { id: "s1", name: null, subtitle: "Mira finds the lantern", messageCount: 40, pinnedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z", lastMessagePreview: "rain again" },
  { id: "s2", name: "Main run", subtitle: null, messageCount: 300, pinnedAt: null, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", lastMessagePreview: "the end" },
  { id: "s3", name: null, subtitle: "I walk to the mill", messageCount: 5, pinnedAt: "2026-04-01T00:00:00Z", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastMessagePreview: "quiet" },
  { id: "s4", name: "Junk", subtitle: null, messageCount: 2, pinnedAt: null, createdAt: "2026-01-04T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", lastMessagePreview: "lantern test" },
  { id: "s5", name: "Old", subtitle: null, messageCount: 1, pinnedAt: null, createdAt: "2026-01-05T00:00:00Z", updatedAt: "2025-12-01T00:00:00Z", lastMessagePreview: "dust" },
].map((s) => ({ ...s, worldId: "world", worldName: "World", worldLanguage: "en", playtimeSeconds: 0 }));

const searchResult = [
  { sessionId: "s2", hitCount: 5, hits: [
    { id: "s2-m237", role: "assistant", position: 237, snippet: "The lantern flickers.", clippedStart: true, clippedEnd: false },
    { id: "s2-m100", role: "user", position: 100, snippet: "I lift the lantern", clippedStart: false, clippedEnd: false },
    { id: "s2-m12", role: "assistant", position: 12, snippet: "a lantern", clippedStart: false, clippedEnd: false },
  ] },
];

async function withPicker(list: typeof saves, run: (h: {
  dom: JSDOM; requests: string[]; jumps: unknown[]; entered: string[]; closed: number[];
  rowNames: () => (string | null)[]; input: () => HTMLInputElement | null; icon: () => HTMLButtonElement | undefined;
  type: (value: string) => Promise<void>; wait: (ms: number) => Promise<void>; key: (init: KeyboardEventInit) => Promise<KeyboardEvent>;
  button: (match: RegExp) => HTMLButtonElement;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://test.local" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/api/sessions/search")) return Response.json({ data: new URL(url, "https://x").searchParams.get("q") === "lantern" ? searchResult : [] });
    if (url.includes("/messages/search")) return Response.json({ data: [{ id: "s2-m3", role: "user", position: 3, snippet: "lantern one", clippedStart: false, clippedEnd: false }], meta: { hasMore: false } });
    if (url.endsWith("/pin")) return Response.json({ data: { pinnedAt: JSON.parse(String(init?.body)).pinned ? "2026-05-01T00:00:00.000Z" : null } });
    return Response.json({ data: list });
  };
  const t = (key: string, opts?: { count?: number; n?: number; name?: string }) =>
    `${key}${opts?.count !== undefined ? `:${opts.count}` : opts?.n !== undefined ? `:${opts.n}` : opts?.name ? `:${opts.name}` : ""}`;
  const jumps: unknown[] = [];
  const entered: string[] = [];
  const closed: number[] = [];
  const modules: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t, i18n: { language: "en" } }) },
    "@/stores/personas": { usePersonasStore: create(() => ({ savingSelection: false, selectionFailed: false })) },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "user" } } }) },
    "@/lib/session-picker-cache": { getCachedSessions: () => null, setCachedSessions: () => {} },
    "@/lib/feedback": { feedback: { error() {} } },
    "@/lib/playtime": { formatPlaytimeShort: () => "0h" },
    "@/lib/format-time": { formatTimeAgo: () => "today" },
    "@/lib/languages": { LANGUAGE_SHORT: {}, variantRowLabels: () => new Map() },
    "@/components/session-modal-styles": {},
    "@/features/chat/world-persona-menu": { WorldPersonaIconMenu: () => null },
    "../lib/pending-message-jump": { requestMessageJump: (jump: unknown) => jumps.push(jump) },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { SessionPickerModal: ComponentType<SessionPickerModalProps> } };
  const source = readFileSync(new URL("./session-picker-modal.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => modules[id] ?? require(id), module, module.exports);
  // Loaded after the DOM globals exist, so React wires real input events.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const rowNames = () => Array.from(document.querySelectorAll(".group > div:first-child > span.truncate")).map((el) => el.textContent);
  const input = () => document.querySelector<HTMLInputElement>('input[type="search"]');
  const icon = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find((el) => el.getAttribute("aria-label") === "header.searchSaves");
  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input()!, value);
      input()!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const key = async (init: KeyboardEventInit) => {
    const event = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => { document.dispatchEvent(event); });
    return event;
  };
  const button = (match: RegExp) => Array.from(document.querySelectorAll("button")).find((el) => match.test(el.textContent ?? "") || match.test(el.getAttribute("aria-label") ?? ""))!;
  try {
    await act(async () => root.render(createElement(module.exports.SessionPickerModal, {
      open: true, onClose: () => closed.push(1), onSelectSession: (id) => entered.push(id), onCreateSession() {},
      world: { id: "world", name: "World" }, variants: [],
    })));
    await wait(0);
    await run({ dom, requests, jumps, entered, closed, rowNames, input, icon, type, wait, key, button });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [k, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else Reflect.deleteProperty(globalThis, k); }
  }
}

test("search filters, groups hits, opens a save at a message, and selects all matching", async () => {
  await withPicker(saves, async ({ dom, requests, jumps, entered, closed, rowNames, input, icon, type, wait, key, button }) => {
    await wait(0);
    // Pinned first, then recently played; unnamed saves show "Session N" + a subtitle.
    assert.deepEqual(rowNames(), ["header.sessionOrdinal:3", "header.sessionOrdinal:1", "Main run", "Junk", "Old"]);
    assert.match(document.body.textContent ?? "", /Mira finds the lantern/);
    // Five saves: the magnifier is in the header, the bar is not.
    assert.ok(icon());
    assert.equal(input(), null);

    // The magnifier opens the bar, focused; its sort: Most messages, remembered.
    await act(async () => icon()!.click());
    assert.equal(icon()!.getAttribute("aria-pressed"), "true");
    assert.equal(document.activeElement, input());
    await act(async () => button(/header\.sortSaves/).click());
    await act(async () => button(/header\.sort\.messages/).click());
    assert.deepEqual(rowNames(), ["header.sessionOrdinal:3", "Main run", "header.sessionOrdinal:1", "Junk", "Old"]);
    assert.equal(dom.window.localStorage.getItem("yumina:save-picker-sort:user"), "messages");
    // The magnifier again hides it; the bar's X with nothing typed does too. The sort stays.
    await act(async () => icon()!.click());
    assert.equal(input(), null);
    assert.deepEqual(rowNames(), ["header.sessionOrdinal:3", "Main run", "header.sessionOrdinal:1", "Junk", "Old"]);
    await act(async () => icon()!.click());
    await act(async () => input()!.parentElement!.querySelector<HTMLButtonElement>('[aria-label="common:action.close"]')!.click());
    assert.equal(input(), null);

    // Ctrl+F opens and focuses the bar instead of the browser's own find.
    const findEvent = await key({ key: "f", ctrlKey: true });
    assert.equal(findEvent.defaultPrevented, true);
    assert.equal(document.activeElement, input());

    // Typing filters at once on name / subtitle / last message…
    await type("lantern");
    assert.deepEqual(rowNames(), ["header.sessionOrdinal:1", "Junk"]);
    // …and after the pause, the server's hits join with counts and snippets.
    await wait(400);
    assert.ok(requests.some((r) => r.includes("/api/sessions/search?worldId=world&q=lantern")));
    assert.deepEqual(rowNames(), ["Main run", "header.sessionOrdinal:1", "Junk"]);
    assert.match(document.body.textContent ?? "", /header\.searchHits:5/);
    const hits = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-save-hit]"));
    assert.deepEqual(hits.map((el) => el.dataset.saveHit), ["237", "100", "12"]);
    assert.equal(hits[0]!.querySelector("mark")?.textContent, "lantern");

    // "More" pages the rest of that save from the per-save search.
    await act(async () => button(/header\.searchMore:2/).click());
    await wait(0);
    assert.ok(requests.some((r) => r.includes("/api/sessions/s2/messages/search?q=lantern&limit=10&before=12")));
    assert.deepEqual(Array.from(document.querySelectorAll<HTMLButtonElement>("[data-save-hit]")).map((el) => el.dataset.saveHit), ["237", "100", "12", "3"]);

    // A snippet opens the save at that message.
    await act(async () => hits[1]!.click());
    assert.deepEqual(jumps, [{ sessionId: "s2", messageId: "s2-m100", position: 100, query: "lantern" }]);
    assert.deepEqual(entered, ["s2"]);

    // Select all matching takes the three matches only.
    await act(async () => button(/^header\.selectSessions$/).click());
    const selectAll = document.querySelector<HTMLInputElement>('[aria-label="header.selectAllMatching:3"]')!;
    assert.ok(selectAll, "select-all names the matches");
    await act(async () => selectAll.click());
    assert.match(button(/header\.deleteSelectedSessions/).textContent ?? "", /:3$/);
    await act(async () => button(/^header\.finishSelectingSessions$/).click());

    // Pin from the row; pinned rows go first.
    const junkRow = Array.from(document.querySelectorAll<HTMLElement>(".group")).find((el) => el.textContent?.includes("Junk"))!;
    await act(async () => junkRow.querySelector<HTMLButtonElement>('[aria-label="header.pinSession"]')!.click());
    await wait(0);
    assert.ok(requests.some((r) => r.startsWith("PUT /api/sessions/s4/pin")));
    assert.equal(rowNames()[0], "Junk");

    // Esc: clear the search, then hide the bar, then close.
    await key({ key: "Escape" });
    assert.equal(input()!.value, "");
    assert.equal(rowNames().length, 5);
    await key({ key: "Escape" });
    assert.equal(input(), null);
    assert.equal(closed.length, 0);
    await key({ key: "Escape" });
    assert.equal(closed.length, 1);

    // Nothing matches: a plain empty line.
    await act(async () => icon()!.click());
    await type("zzz");
    await wait(400);
    assert.match(document.body.textContent ?? "", /header\.noMatchingSaves/);
  });
});

test("a card with few saves shows no magnifier and leaves Ctrl+F to the browser", async () => {
  await withPicker(saves.slice(0, 3), async ({ rowNames, input, icon, key }) => {
    assert.equal(rowNames().length, 3);
    assert.equal(icon(), undefined);
    assert.equal(input(), null);
    assert.equal((await key({ key: "f", ctrlKey: true })).defaultPrevented, false);
    assert.equal(input(), null);
    // Pins still lead and unnamed saves keep their subtitle.
    assert.equal(rowNames()[0], "header.sessionOrdinal:3");
    assert.match(document.body.textContent ?? "", /Mira finds the lantern/);
  });
});
