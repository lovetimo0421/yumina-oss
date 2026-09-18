import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { fetchWorldUpdatePage } from "./world-update-history-data.js";
import { postWorldUpdateNote } from "../editor/world-update-note.js";

const testI18n = createInstance();
await testI18n.init({
  lng: "en",
  resources: {
    en: {
      library: {
        detail: {
          updateHistoryLoading: "Loading update history...",
          updateHistoryLoadError: "Couldn't load update history.",
          updateHistoryRetry: "Try again",
          noUpdateHistory: "No update history yet.",
          updateHistoryListLabel: "Card update history",
          majorUpdate: "Major update",
          updatedBy: "Updated by {{name}}",
          unknown: "Unknown",
          updateHistoryLoadMoreError: "Couldn't load older updates.",
          loadOlderUpdates: "Load older updates",
          loadingOlderUpdates: "Loading older updates...",
          editUpdate: "Edit",
          editUpdateTitle: "Edit update record",
          updateTitleLabel: "Title",
          updateContentLabel: "Update details (optional)",
          updateContentPlaceholder: "Describe the changes...",
          updateSave: "Save",
          updateCancel: "Cancel",
          updateSaving: "Saving...",
          updateSaveError: "Couldn't save changes. Try again.",
          updateTitleRequired: "Enter a title.",
          updateSaved: "Changes saved.",
        },
      },
    },
  },
});

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "DocumentFragment",
  "Node",
  "NodeFilter",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CustomEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
  "fetch",
] as const;

async function createHistoryHarness(fetcher: typeof fetch) {
  const dom = new JSDOM("<div id=\"root\"></div>", { pretendToBeVisual: true });
  const previousDescriptors = new Map(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const installGlobal = (key: (typeof globalKeys)[number], value: unknown) => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  installGlobal("window", dom.window);
  installGlobal("document", dom.window.document);
  installGlobal("navigator", dom.window.navigator);
  installGlobal("HTMLElement", dom.window.HTMLElement);
  installGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  installGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  installGlobal("Element", dom.window.Element);
  installGlobal("DocumentFragment", dom.window.DocumentFragment);
  installGlobal("Node", dom.window.Node);
  installGlobal("NodeFilter", dom.window.NodeFilter);
  installGlobal("Event", dom.window.Event);
  installGlobal("MouseEvent", dom.window.MouseEvent);
  installGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  installGlobal("CustomEvent", dom.window.CustomEvent);
  installGlobal("MutationObserver", dom.window.MutationObserver);
  installGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  installGlobal("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  installGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installGlobal("fetch", fetcher);

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  // React DOM and Radix select their browser behavior during module evaluation.
  const [{ createRoot }, { WorldUpdateHistory }] = await Promise.all([
    import("react-dom/client"),
    import("./world-update-history.js"),
  ]);
  let root: Root | null = createRoot(container);

  const render = async (worldId: string, creatorName = "Mia", canEdit = false) => {
    await act(async () => {
      root?.render(createElement(
        I18nextProvider,
        { i18n: testI18n },
        createElement(WorldUpdateHistory, { worldId, creatorName, canEdit }),
      ));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const cleanup = async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousDescriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };

  const click = async (button: Element) => {
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
  };

  const enter = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = input.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    assert.ok(setValue);
    await act(async () => {
      setValue.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  return { container, dom, render, flush, click, enter, cleanup };
}

function buttonNamed(scope: ParentNode, name: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button"))
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent)?.trim() === name);
  assert.ok(button, `Expected a button named ${name}`);
  return button;
}

function inputLabelled(document: Document, label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelElement = Array.from(document.querySelectorAll("label"))
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(labelElement, `Expected a label named ${label}`);
  const input = document.getElementById(labelElement.htmlFor);
  assert.ok(input?.tagName === "INPUT" || input?.tagName === "TEXTAREA");
  return input as HTMLInputElement | HTMLTextAreaElement;
}

function update(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    worldId: "world-a",
    title,
    content: null,
    isMajor: false,
    createdAt: "2026-08-24T12:00:00.000Z",
    creatorName: null,
    ...overrides,
  };
}

test("update history requests encoded paginated URLs and filters malformed rows", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({
      data: [
        update("one", "  Chapter 3  ", { content: "  New ending  ", isMajor: true }),
        update("blank", "   "),
        { id: 3, title: "Invalid", createdAt: "now" },
      ],
      hasMore: true,
      nextOffset: 20,
    }), { status: 200 });
  }) as typeof fetch;

  const page = await fetchWorldUpdatePage({
    worldId: "world / one",
    offset: 0,
    baseUrl: "https://api.example",
    fetcher,
  });

  assert.equal(requestedUrl, "https://api.example/api/worlds/world%20%2F%20one/updates?offset=0");
  assert.equal(requestedInit?.credentials, "include");
  assert.deepEqual(page, {
    canEdit: false,
    items: [{
      id: "one",
      worldId: "world-a",
      title: "Chapter 3",
      content: "New ending",
      isMajor: true,
      createdAt: "2026-08-24T12:00:00.000Z",
      creatorName: null,
    }],
    hasMore: true,
    nextOffset: 20,
  });
});

test("update history renders authored details and loads older entries without duplicates", async () => {
  const requestedUrls: string[] = [];
  const fetcher = (async (input: URL | RequestInfo) => {
    requestedUrls.push(String(input));
    const isOlderPage = String(input).endsWith("offset=20");
    return new Response(JSON.stringify(isOlderPage
      ? { data: [update("one", "Chapter 3"), update("two", "Balance pass")], hasMore: false }
      : {
          data: [update("one", "Chapter 3", {
            content: "Added a new ending.",
            isMajor: true,
            creatorName: "Variant Author",
          })],
          hasMore: true,
          nextOffset: 20,
        }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a");
    assert.match(harness.container.textContent ?? "", /Chapter 3/);
    assert.match(harness.container.textContent ?? "", /Added a new ending\./);
    assert.match(harness.container.textContent ?? "", /Major update/);
    assert.match(harness.container.textContent ?? "", /Updated by Variant Author/);

    const button = Array.from(harness.container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Load older updates"));
    assert.ok(button);
    await act(async () => button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true })));
    await harness.flush();

    assert.deepEqual(requestedUrls, [
      "/api/worlds/world-a/updates?offset=0",
      "/api/worlds/world-a/updates?offset=20",
    ]);
    assert.equal((harness.container.textContent ?? "").match(/Chapter 3/g)?.length, 1);
    assert.match(harness.container.textContent ?? "", /Balance pass/);
  } finally {
    await harness.cleanup();
  }
});
test("failed update history can retry without losing the card context", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return calls === 1
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ data: [update("fixed", "Recovered update")] }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a");
    assert.match(harness.container.textContent ?? "", /Couldn't load update history/);
    const retry = harness.container.querySelector("button");
    assert.ok(retry);
    await act(async () => retry.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true })));
    await harness.flush();
    assert.equal(calls, 2);
    assert.match(harness.container.textContent ?? "", /Recovered update/);
  } finally {
    await harness.cleanup();
  }
});

test("switching cards aborts the previous request and suppresses its stale result", async () => {
  const requests: Array<{
    url: string;
    signal?: AbortSignal;
    resolve: (response: Response) => void;
  }> = [];
  const fetcher = ((input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ url: String(input), signal: init?.signal ?? undefined, resolve });
  })) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a");
    await harness.render("world-b");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.signal?.aborted, true);

    requests[1]?.resolve(new Response(JSON.stringify({ data: [update("b", "World B update")] }), { status: 200 }));
    await harness.flush();
    assert.match(harness.container.textContent ?? "", /World B update/);

    requests[0]?.resolve(new Response(JSON.stringify({ data: [update("a", "Stale world A update")] }), { status: 200 }));
    await harness.flush();
    assert.doesNotMatch(harness.container.textContent ?? "", /Stale world A update/);
    assert.match(harness.container.textContent ?? "", /World B update/);
  } finally {
    await harness.cleanup();
  }
});

test("only owners can edit update records with a known source card", async () => {
  const fetcher = (async () => new Response(JSON.stringify({
    canEdit: true,
    data: [
      update("editable", "Editable update"),
      update("legacy", "Legacy update", { worldId: null }),
    ],
  }), { status: 200 })) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a");
    assert.equal(harness.container.querySelectorAll("button").length, 0);

    await harness.render("world-a", "Mia", true);
    assert.equal(harness.container.querySelectorAll("button").length, 1);
    const editableArticle = Array.from(harness.container.querySelectorAll("article"))
      .find((article) => article.textContent?.includes("Editable update"));
    assert.ok(editableArticle);
    assert.ok(buttonNamed(editableArticle, "Edit"));
    const legacyArticle = Array.from(harness.container.querySelectorAll("article"))
      .find((article) => article.textContent?.includes("Legacy update"));
    assert.ok(legacyArticle);
    assert.equal(legacyArticle.querySelector("button"), null);
  } finally {
    await harness.cleanup();
  }
});

test("a caller cannot offer editing without explicit server author permission", async () => {
  const fetcher = (async (input: URL | RequestInfo) => new Response(JSON.stringify({
    data: [update("one", "Readable update")],
    ...(String(input).includes("world-a") ? { canEdit: false } : {}),
  }), { status: 200 })) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    for (const worldId of ["world-a", "legacy-api"]) {
      await harness.render(worldId, "Mia", true);
      assert.match(harness.container.textContent ?? "", /Readable update/);
      assert.equal(harness.container.querySelectorAll("button").length, 0);
      assert.equal(harness.dom.window.document.querySelector('[role="dialog"]'), null);
    }
  } finally {
    await harness.cleanup();
  }
});

test("entering read-only mode closes an open edit without saving", async () => {
  let saves = 0;
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "PATCH") saves += 1;
    return new Response(JSON.stringify({ data: [update("one", "Published title")], canEdit: true }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a", "Mia", true);
    await harness.click(buttonNamed(harness.container, "Edit"));
    assert.ok(harness.dom.window.document.querySelector('[role="dialog"]'));
    await harness.render("world-a", "Mia", false);
    assert.equal(harness.dom.window.document.querySelector('[role="dialog"]'), null);
    assert.equal(harness.container.querySelectorAll("button").length, 0);
    assert.equal(saves, 0);
  } finally {
    await harness.cleanup();
  }
});

test("the edit dialog saves to the source card and preserves publication metadata", async () => {
  const original = update("record / one", "Original title", {
    worldId: "translated / card",
    content: "Original details",
    isMajor: true,
    creatorName: "Variant Author",
  });
  const saves: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      saves.push({ url: String(input), init });
      return new Response(JSON.stringify({
        data: { ...original, title: "Corrected title", content: "Corrected details" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [original], canEdit: true }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a", "Mia", true);
    const originalTime = harness.container.querySelector("time")?.dateTime;
    await harness.click(buttonNamed(harness.container, "Edit"));
    const document = harness.dom.window.document;
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent,
      "Edit update record");
    assert.equal(harness.container.contains(dialog), false, "Dialog should be rendered in a portal");
    const title = inputLabelled(document, "Title");
    const content = inputLabelled(document, "Update details (optional)");
    assert.equal(title.value, "Original title");
    assert.equal(content.value, "Original details");
    await harness.enter(title, "Corrected title");
    await harness.enter(content, "Corrected details");
    await harness.click(buttonNamed(dialog, "Save"));

    assert.equal(saves.length, 1);
    assert.equal(saves[0]?.url, "/api/worlds/translated%20%2F%20card/updates/record%20%2F%20one");
    assert.equal(saves[0]?.init?.credentials, "include");
    assert.deepEqual(JSON.parse(String(saves[0]?.init?.body)), {
      title: "Corrected title",
      content: "Corrected details",
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(harness.container.textContent ?? "", /Corrected title/);
    assert.match(harness.container.textContent ?? "", /Corrected details/);
    assert.doesNotMatch(harness.container.textContent ?? "", /Original title/);
    assert.match(harness.container.textContent ?? "", /Major update/);
    assert.match(harness.container.textContent ?? "", /Updated by Variant Author/);
    assert.equal(harness.container.querySelector("time")?.dateTime, originalTime);
  } finally {
    await harness.cleanup();
  }
});

test("publishing a note refreshes an already mounted empty history", async () => {
  let published = false;
  let reads = 0;
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      published = true;
      return new Response("{}", { status: 201 });
    }
    reads += 1;
    return new Response(JSON.stringify({
      data: published ? [update("new", "Fresh update")] : [],
      canEdit: true,
    }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  try {
    await harness.render("world-a", "Mia", true);
    assert.match(harness.container.textContent ?? "", /No update history yet/);
    await act(async () => {
      await postWorldUpdateNote({ worldId: "world-a", title: "Fresh update", content: "", isMajor: false, held: false, fetcher });
    });
    await harness.flush();
    assert.equal(reads, 2);
    assert.match(harness.container.textContent ?? "", /Fresh update/);
    assert.ok(buttonNamed(harness.container, "Edit"));
  } finally {
    await harness.cleanup();
  }
});

test("dialog undo and save shortcuts stay separate from the editor's work shortcuts", async () => {
  let saves = 0;
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      saves += 1;
      return new Response(JSON.stringify({ data: update("one", "Corrected title") }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [update("one", "Published title")], canEdit: true }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  let outerShortcuts = 0;
  const outerHandler = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey) outerShortcuts += 1;
  };
  harness.dom.window.addEventListener("keydown", outerHandler as EventListener);
  try {
    await harness.render("world-a", "Mia", true);
    await harness.click(buttonNamed(harness.container, "Edit"));
    const input = inputLabelled(harness.dom.window.document, "Title");
    await harness.enter(input, "Corrected title");
    for (const options of [{ key: "z", ctrlKey: true }, { key: "y", ctrlKey: true }, { key: "Z", shiftKey: true, metaKey: true }]) {
      const event = new harness.dom.window.KeyboardEvent("keydown", { ...options, bubbles: true, cancelable: true });
      await act(async () => { input.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, false, "Native text undo/redo must remain available");
    }
    const saveEvent = new harness.dom.window.KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(saveEvent); });
    await harness.flush();
    assert.equal(saveEvent.defaultPrevented, true);
    assert.equal(outerShortcuts, 0);
    assert.equal(saves, 1);
    assert.match(harness.container.textContent ?? "", /Corrected title/);
  } finally {
    harness.dom.window.removeEventListener("keydown", outerHandler as EventListener);
    await harness.cleanup();
  }
});

test("cancel discards an edit without sending a save request", async () => {
  let saves = 0;
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "PATCH") saves += 1;
    return new Response(JSON.stringify({ data: [update("one", "Published title")], canEdit: true }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a", "Mia", true);
    await harness.click(buttonNamed(harness.container, "Edit"));
    const document = harness.dom.window.document;
    await harness.enter(inputLabelled(document, "Title"), "Discard this title");
    await harness.click(buttonNamed(document, "Cancel"));

    assert.equal(saves, 0);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(harness.container.textContent ?? "", /Published title/);
    await harness.click(buttonNamed(harness.container, "Edit"));
    assert.equal(inputLabelled(document, "Title").value, "Published title");
    assert.equal(inputLabelled(document, "Update details (optional)").value, "");
  } finally {
    await harness.cleanup();
  }
});

test("failed saves retain entered text and can be retried", async () => {
  let saves = 0;
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      saves += 1;
      return saves === 1
        ? new Response(JSON.stringify({ error: "Temporarily unavailable" }), { status: 503 })
        : new Response(JSON.stringify({ data: update("one", "Retained correction", {
            content: "Retained details",
          }) }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [update("one", "Published title")], canEdit: true }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a", "Mia", true);
    await harness.click(buttonNamed(harness.container, "Edit"));
    const document = harness.dom.window.document;
    await harness.enter(inputLabelled(document, "Title"), "Retained correction");
    await harness.enter(inputLabelled(document, "Update details (optional)"), "Retained details");
    await harness.click(buttonNamed(document, "Save"));

    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.ok(dialog.querySelector('[role="alert"]'));
    assert.equal(inputLabelled(document, "Title").value, "Retained correction");
    assert.equal(inputLabelled(document, "Update details (optional)").value, "Retained details");
    assert.match(harness.container.textContent ?? "", /Published title/);

    await harness.click(buttonNamed(dialog, "Save"));
    assert.equal(saves, 2);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(harness.container.textContent ?? "", /Retained correction/);
    assert.match(harness.container.textContent ?? "", /Retained details/);
  } finally {
    await harness.cleanup();
  }
});

test("switching cards during a save closes the dialog and ignores its stale response", async () => {
  let finishSave: ((response: Response) => void) | undefined;
  let saveSignal: AbortSignal | null | undefined;
  const fetcher = ((input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      saveSignal = init.signal;
      return new Promise<Response>((resolve) => { finishSave = resolve; });
    }
    return Promise.resolve(new Response(JSON.stringify({ data: [
      String(input).includes("world-b")
        ? update("b", "World B update", { worldId: "world-b" })
        : update("a", "World A update"),
    ], canEdit: true }), { status: 200 }));
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);

  try {
    await harness.render("world-a", "Mia", true);
    await harness.click(buttonNamed(harness.container, "Edit"));
    const document = harness.dom.window.document;
    await harness.enter(inputLabelled(document, "Title"), "Late correction");
    await harness.click(buttonNamed(document, "Save"));
    assert.ok(finishSave);

    await harness.render("world-b", "Mia", true);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(harness.container.textContent ?? "", /World B update/);
    assert.equal(saveSignal?.aborted, true);

    finishSave(new Response(JSON.stringify({ data: update("a", "Late correction") }), { status: 200 }));
    await harness.flush();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(harness.container.textContent ?? "", /World B update/);
    assert.doesNotMatch(harness.container.textContent ?? "", /Late correction/);
  } finally {
    await harness.cleanup();
  }
});
