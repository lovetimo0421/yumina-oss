import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { WorldUpdateHistory } from "./world-update-history.js";
import { fetchWorldUpdatePage } from "./world-update-history-data.js";

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
  "Node",
  "Event",
  "MouseEvent",
  "IS_REACT_ACT_ENVIRONMENT",
  "fetch",
] as const;

function createHistoryHarness(fetcher: typeof fetch) {
  const dom = new JSDOM("<div id=\"root\"></div>");
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
  installGlobal("Node", dom.window.Node);
  installGlobal("Event", dom.window.Event);
  installGlobal("MouseEvent", dom.window.MouseEvent);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installGlobal("fetch", fetcher);

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  let root: Root | null = createRoot(container);

  const render = async (worldId: string, creatorName = "Mia") => {
    await act(async () => {
      root?.render(createElement(
        I18nextProvider,
        { i18n: testI18n },
        createElement(WorldUpdateHistory, { worldId, creatorName }),
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

  return { container, dom, render, flush, cleanup };
}

function update(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
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
    items: [{
      id: "one",
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
  const harness = createHistoryHarness(fetcher);

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
  const harness = createHistoryHarness(fetcher);

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
  const harness = createHistoryHarness(fetcher);

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
