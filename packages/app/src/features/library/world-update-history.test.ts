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
          addUpdate: "Add record",
          createUpdateTitle: "Add update record",
          updateAdd: "Add",
          updateAdding: "Adding…",
          updateCreated: "Added.",
          updateCreateError: "Could not add the record. Try again.",
          updateMajorLabel: "Mark as a major update",
          updateNotifyPlayers: "Notify players who favorited this world",
          updateNotifyAfterPublish: "Publish the world to notify players.",
          updateCreateBlocked: "Add records after the pending review is resolved.",
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

  const render = async (worldId: string, creatorName = "Mia", canEdit = false, showCreateButton = false) => {
    await act(async () => {
      root?.render(createElement(
        I18nextProvider,
        { i18n: testI18n },
        createElement(WorldUpdateHistory, { worldId, creatorName, canEdit, showCreateButton }),
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
      // Radix FocusScope restores focus and dispatches its unmount event from a
      // setTimeout(0) after the dialog unmounts. Let those timers fire while this
      // realm's globals are still installed; otherwise they run after the test
      // ended, dispatch a foreign-realm CustomEvent, and node:test fails the
      // whole file ("generated asynchronous activity after the test ended").
      await flush();
      await flush();
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

function checkboxLabelled(document: Document, label: string): HTMLInputElement {
  const labelElement = Array.from(document.querySelectorAll("label"))
    .find((candidate) => candidate.textContent?.trim() === label);
  const checkbox = labelElement?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(checkbox, `Expected a checkbox labelled ${label}`);
  return checkbox;
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
    canCreate: false,
    canNotify: false,
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

test("Overview creates a quiet record, refreshes history, and then edits the same record", async () => {
  let record: ReturnType<typeof update> | null = null;
  let reads = 0;
  const writes: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "PATCH") {
      writes.push({ url: String(input), init });
      const body = JSON.parse(String(init.body));
      record = init.method === "POST"
        ? update("created", body.title, { content: body.content, isMajor: body.isMajor })
        : { ...record!, title: body.title, content: body.content };
      return new Response(JSON.stringify({ data: record }), { status: init.method === "POST" ? 201 : 200 });
    }
    reads += 1;
    return new Response(JSON.stringify({
      data: record ? [record] : [], canEdit: true, canCreate: true, canNotify: true,
    }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  try {
    await harness.render("world-a", "Mia", true, true);
    assert.match(harness.container.textContent ?? "", /No update history yet/);
    await harness.click(buttonNamed(harness.container, "Add record"));
    const document = harness.dom.window.document;
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent, "Add update record");
    assert.equal(checkboxLabelled(document, "Mark as a major update").checked, false);
    assert.equal(checkboxLabelled(document, "Notify players who favorited this world").checked, false);
    await harness.enter(inputLabelled(document, "Title"), "New standalone record");
    await harness.enter(inputLabelled(document, "Update details (optional)"), "Standalone details");
    await harness.click(buttonNamed(dialog, "Add"));

    assert.equal(reads, 2, "Successful creation must refresh the mounted list");
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.url, "/api/worlds/world-a/updates");
    assert.equal(writes[0]?.init.credentials, "include");
    assert.deepEqual(JSON.parse(String(writes[0]?.init.body)), {
      title: "New standalone record", content: "Standalone details", isMajor: false, notifyPlayers: false,
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(harness.container.querySelectorAll("article").length, 1);
    assert.match(harness.container.textContent ?? "", /New standalone record/);
    assert.match(harness.container.textContent ?? "", /Added\./);
    const publishedAt = harness.container.querySelector("time")?.dateTime;

    await harness.click(buttonNamed(harness.container, "Edit"));
    assert.equal(document.querySelectorAll('input[type="checkbox"]').length, 0, "Editing must not offer notification controls");
    await harness.enter(inputLabelled(document, "Title"), "Corrected standalone record");
    await harness.click(buttonNamed(document, "Save"));
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.url, "/api/worlds/world-a/updates/created");
    assert.equal(writes[1]?.init.method, "PATCH");
    assert.deepEqual(JSON.parse(String(writes[1]?.init.body)), {
      title: "Corrected standalone record", content: "Standalone details",
    });
    assert.equal(harness.container.querySelectorAll("article").length, 1);
    assert.equal(harness.container.querySelector("time")?.dateTime, publishedAt);
    assert.match(harness.container.textContent ?? "", /Corrected standalone record/);
  } finally {
    await harness.cleanup();
  }
});

test("authors can opt into notifications and a major update for a new record", async () => {
  let submitted: Record<string, unknown> | undefined;
  const created = update("major", "New chapter", { isMajor: true });
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      submitted = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: created }), { status: 201 });
    }
    return new Response(JSON.stringify({
      data: submitted ? [created] : [], canEdit: true, canCreate: true, canNotify: true,
    }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  try {
    await harness.render("world-a", "Mia", true, true);
    await harness.click(buttonNamed(harness.container, "Add record"));
    const document = harness.dom.window.document;
    await harness.enter(inputLabelled(document, "Title"), "New chapter");
    await harness.click(checkboxLabelled(document, "Mark as a major update"));
    await harness.click(checkboxLabelled(document, "Notify players who favorited this world"));
    await harness.click(buttonNamed(document, "Add"));
    assert.deepEqual(submitted, { title: "New chapter", content: "", isMajor: true, notifyPlayers: true });
    assert.match(harness.container.textContent ?? "", /Major update/);
  } finally {
    await harness.cleanup();
  }
});

test("unpublished works can add records silently without notification controls", async () => {
  let submitted: Record<string, unknown> | undefined;
  const created = update("quiet", "Private correction");
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      submitted = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: created }), { status: 201 });
    }
    return new Response(JSON.stringify({
      data: submitted ? [created] : [], canEdit: true, canCreate: true, canNotify: false,
    }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  try {
    await harness.render("world-a", "Mia", true, true);
    await harness.click(buttonNamed(harness.container, "Add record"));
    const document = harness.dom.window.document;
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(dialog.querySelectorAll('input[type="checkbox"]').length, 1);
    assert.ok(checkboxLabelled(document, "Mark as a major update"));
    assert.doesNotMatch(dialog.textContent ?? "", /Notify players who favorited/);
    assert.match(dialog.textContent ?? "", /Publish the world to notify players/);
    await harness.enter(inputLabelled(document, "Title"), "Private correction");
    await harness.click(buttonNamed(dialog, "Add"));
    assert.equal(submitted?.notifyPlayers, false);
    assert.match(harness.container.textContent ?? "", /Private correction/);
  } finally {
    await harness.cleanup();
  }
});

test("creation requires author and surface permission while review blocks only new records", async () => {
  let posts = 0;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") posts += 1;
    const worldId = String(input).split("/")[3]!;
    return new Response(JSON.stringify({
      data: [update("existing", "Existing update", { worldId })],
      canEdit: worldId !== "nonowner", canCreate: worldId !== "review", canNotify: true,
    }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  try {
    for (const [worldId, canEdit, showCreate] of [
      ["nonowner", true, true], ["readonly", false, true], ["library", true, false],
    ] as const) {
      await harness.render(worldId, "Mia", canEdit, showCreate);
      assert.equal(Array.from(harness.container.querySelectorAll("button"))
        .some((button) => button.textContent?.trim() === "Add record"), false, worldId);
    }
    await harness.render("review", "Mia", true, true);
    const addButton = buttonNamed(harness.container, "Add record");
    assert.equal(addButton.disabled, true);
    assert.match(harness.container.textContent ?? "", /pending review is resolved/);
    await harness.click(addButton);
    assert.equal(harness.dom.window.document.querySelector('[role="dialog"]'), null);
    await harness.click(buttonNamed(harness.container, "Edit"));
    assert.equal(inputLabelled(harness.dom.window.document, "Title").value, "Existing update");
    assert.equal(posts, 0);
  } finally {
    await harness.cleanup();
  }
});

test("failed creation retains the draft and a pending retry cannot create duplicates", async () => {
  let attempts = 0;
  let finishCreate: ((response: Response) => void) | undefined;
  let created = false;
  const record = update("retry", "Retained title", { content: "Retained details" });
  const fetcher = ((_: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      attempts += 1;
      if (attempts === 1) return Promise.resolve(new Response("{}", { status: 503 }));
      return new Promise<Response>((resolve) => { finishCreate = resolve; });
    }
    return Promise.resolve(new Response(JSON.stringify({
      data: created ? [record] : [], canEdit: true, canCreate: true, canNotify: true,
    }), { status: 200 }));
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  try {
    await harness.render("world-a", "Mia", true, true);
    await harness.click(buttonNamed(harness.container, "Add record"));
    const document = harness.dom.window.document;
    await harness.enter(inputLabelled(document, "Title"), "Retained title");
    await harness.enter(inputLabelled(document, "Update details (optional)"), "Retained details");
    await harness.click(buttonNamed(document, "Add"));
    assert.equal(attempts, 1);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Could not add the record/);
    assert.equal(inputLabelled(document, "Title").value, "Retained title");
    assert.equal(inputLabelled(document, "Update details (optional)").value, "Retained details");

    await harness.click(buttonNamed(document, "Add"));
    const addingButton = buttonNamed(document, "Adding…");
    assert.equal(addingButton.disabled, true);
    assert.equal(buttonNamed(document, "Cancel").disabled, true);
    assert.equal(inputLabelled(document, "Title").disabled, true);
    await harness.click(addingButton);
    const form = document.querySelector("form");
    assert.ok(form);
    await act(async () => {
      form.dispatchEvent(new harness.dom.window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new harness.dom.window.KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(attempts, 2, "Repeated button, submit, and shortcut events must share one request");
    assert.ok(finishCreate);
    created = true;
    finishCreate(new Response(JSON.stringify({ data: record }), { status: 201 }));
    await harness.flush();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(harness.container.querySelectorAll("article").length, 1);
    assert.match(harness.container.textContent ?? "", /Retained details/);
  } finally {
    await harness.cleanup();
  }
});

test("cancelled or blank new records never send a creation request", async () => {
  let posts = 0;
  const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") posts += 1;
    return new Response(JSON.stringify({ data: [], canEdit: true, canCreate: true, canNotify: true }), { status: 200 });
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  try {
    await harness.render("world-a", "Mia", true, true);
    await harness.click(buttonNamed(harness.container, "Add record"));
    const document = harness.dom.window.document;
    await harness.enter(inputLabelled(document, "Title"), "   ");
    await harness.click(buttonNamed(document, "Add"));
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Enter a title/);
    assert.equal(posts, 0);
    await harness.enter(inputLabelled(document, "Title"), "Discard draft");
    await harness.click(checkboxLabelled(document, "Notify players who favorited this world"));
    await harness.click(buttonNamed(document, "Cancel"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await harness.click(buttonNamed(harness.container, "Add record"));
    assert.equal(inputLabelled(document, "Title").value, "");
    assert.equal(checkboxLabelled(document, "Notify players who favorited this world").checked, false);
    assert.equal(posts, 0);
  } finally {
    await harness.cleanup();
  }
});

test("switching works aborts a pending creation and suppresses its stale result", async () => {
  let finishCreate: ((response: Response) => void) | undefined;
  let createSignal: AbortSignal | null | undefined;
  let reads = 0;
  const fetcher = ((input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      createSignal = init.signal;
      return new Promise<Response>((resolve) => { finishCreate = resolve; });
    }
    reads += 1;
    return Promise.resolve(new Response(JSON.stringify({
      data: String(input).includes("world-b") ? [update("b", "World B update", { worldId: "world-b" })] : [],
      canEdit: true, canCreate: true, canNotify: true,
    }), { status: 200 }));
  }) as typeof fetch;
  const harness = await createHistoryHarness(fetcher);
  try {
    await harness.render("world-a", "Mia", true, true);
    await harness.click(buttonNamed(harness.container, "Add record"));
    const document = harness.dom.window.document;
    await harness.enter(inputLabelled(document, "Title"), "Stale created record");
    await harness.click(buttonNamed(document, "Add"));
    assert.ok(finishCreate);
    await harness.render("world-b", "Mia", true, true);
    assert.equal(createSignal?.aborted, true);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(harness.container.textContent ?? "", /World B update/);
    finishCreate(new Response(JSON.stringify({ data: update("stale", "Stale created record") }), { status: 201 }));
    await harness.flush();
    assert.equal(reads, 2, "A stale create must not emit a refresh for the new work");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.doesNotMatch(harness.container.textContent ?? "", /Stale created record|Added\./);
    assert.match(harness.container.textContent ?? "", /World B update/);
  } finally {
    await harness.cleanup();
  }
});

test("a delayed creation refresh cannot overwrite a record edited before that refresh finishes", async () => {
  for (const refreshFails of [false, true]) {
    let reads = 0;
    let edits = 0;
    let finishRefresh: ((response: Response) => void) | undefined;
    const created = update("created", "Original created title");
    const corrected = { ...created, title: "Corrected before refresh", content: "Saved correction" };
    const fetcher = ((_: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ data: created }), { status: 201 }));
      }
      if (init?.method === "PATCH") {
        edits += 1;
        assert.deepEqual(JSON.parse(String(init.body)), {
          title: corrected.title, content: corrected.content,
        });
        return Promise.resolve(new Response(JSON.stringify({ data: corrected }), { status: 200 }));
      }
      reads += 1;
      if (reads === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [], canEdit: true, canCreate: true, canNotify: true,
        }), { status: 200 }));
      }
      return new Promise<Response>((resolve) => { finishRefresh = resolve; });
    }) as typeof fetch;
    const harness = await createHistoryHarness(fetcher);
    try {
      await harness.render("world-a", "Mia", true, true);
      await harness.click(buttonNamed(harness.container, "Add record"));
      const document = harness.dom.window.document;
      await harness.enter(inputLabelled(document, "Title"), created.title);
      await harness.click(buttonNamed(document, "Add"));
      assert.equal(reads, 2);
      assert.ok(finishRefresh, "Creation must start a refresh that stays pending during the edit");
      assert.match(harness.container.textContent ?? "", /Original created title/);

      await harness.click(buttonNamed(harness.container, "Edit"));
      await harness.enter(inputLabelled(document, "Title"), corrected.title);
      await harness.enter(inputLabelled(document, "Update details (optional)"), corrected.content);
      await harness.click(buttonNamed(document, "Save"));
      assert.equal(edits, 1);
      assert.match(harness.container.textContent ?? "", /Corrected before refresh/);
      assert.match(harness.container.textContent ?? "", /Saved correction/);

      finishRefresh(refreshFails
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({
            data: [created], canEdit: true, canCreate: true, canNotify: true,
          }), { status: 200 }));
      await harness.flush();
      assert.equal(reads, 2, "Protecting the saved edit should not require another history request");
      assert.equal(harness.container.querySelectorAll("article").length, 1);
      assert.match(harness.container.textContent ?? "", /Corrected before refresh/);
      assert.match(harness.container.textContent ?? "", /Saved correction/);
      assert.doesNotMatch(harness.container.textContent ?? "", /Original created title|Couldn't load update history/);
      await harness.click(buttonNamed(harness.container, "Edit"));
      assert.equal(inputLabelled(document, "Title").value, corrected.title);
      assert.equal(inputLabelled(document, "Update details (optional)").value, corrected.content);
    } finally {
      await harness.cleanup();
    }
  }
});
