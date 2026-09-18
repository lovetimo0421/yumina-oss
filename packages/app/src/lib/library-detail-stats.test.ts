import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  useActivityStats,
  type ActivityStats,
} from "./library-detail-stats.js";

type HookOptions = ActivityStats & {
  apiBase: string;
  enabled: boolean;
  creatorAnalyticsEnabled?: boolean;
  fetcher?: typeof fetch;
};

type HookResult = ReturnType<typeof useActivityStats>;

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function createHookHarness() {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  });

  let latest: HookResult | undefined;
  let root: Root | undefined;

  function Harness(options: HookOptions) {
    const result = useActivityStats(options);
    useEffect(() => {
      latest = result;
    }, [result]);
    return null;
  }

  return {
    get current() {
      assert.ok(latest, "the hook should have rendered");
      return latest;
    },
    async render(options: HookOptions) {
      root ??= createRoot(dom.window.document.getElementById("root")!);
      await act(async () => {
        root!.render(createElement(Harness, options));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async unmount() {
      if (root) {
        await act(async () => root!.unmount());
      }
      dom.window.close();
      Object.assign(globalThis, {
        window: previousWindow,
        document: previousDocument,
        HTMLElement: previousHTMLElement,
        Node: previousNode,
      });
    },
  };
}

const baseline: ActivityStats = {
  worldId: "world-a",
  downloadCount: 10,
  messageCount: undefined,
  favoriteCount: undefined,
};

const desktopPanelSource = readFileSync(
  fileURLToPath(new URL("../features/library/library-detail-panel-desktop.tsx", import.meta.url)),
  "utf8",
);
const mobilePanelSource = readFileSync(
  fileURLToPath(new URL("../features/library/library-detail-panel-mobile.tsx", import.meta.url)),
  "utf8",
);

test("all accessible library details request the expanded activity metrics", () => {
  assert.match(desktopPanelSource, /const canViewCreatorAnalytics = true;/);
  assert.match(mobilePanelSource, /const canViewCreatorAnalytics = true;/);
});

test("activity stats hydrate every numeric counter from the preview response", async () => {
  const harness = createHookHarness();
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({
      data: { downloadCount: 12, messageCount: 34, favoriteCount: 56 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await harness.render({ ...baseline, apiBase: "https://api.example", enabled: true, fetcher });
    assert.equal(requestedUrl, "https://api.example/api/worlds/world-a?preview=true");
    assert.equal(requestedInit?.credentials, "include");
    assert.ok(requestedInit?.signal instanceof AbortSignal);
    assert.deepEqual(harness.current.activityStats, {
      worldId: "world-a",
      downloadCount: 12,
      messageCount: 34,
      favoriteCount: 56,
    });
  } finally {
    await harness.unmount();
  }
});
test("activity stats retain each baseline field omitted from a partial response", async () => {
  const harness = createHookHarness();
  const fetcher = (async () => new Response(JSON.stringify({
    data: { messageCount: 34 },
  }), { status: 200 })) as typeof fetch;
  const partialBaseline = { ...baseline, favoriteCount: 7 };

  try {
    await harness.render({ ...partialBaseline, apiBase: "", enabled: true, fetcher });
    assert.deepEqual(harness.current.activityStats, {
      worldId: "world-a",
      downloadCount: 10,
      messageCount: 34,
      favoriteCount: 7,
    });
  } finally {
    await harness.unmount();
  }
});

test("expanded activity stats hydrate from the public aggregate endpoint", async () => {
  const harness = createHookHarness();
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({
      data: {
        totalUniquePlayers: 18,
        avgSessionSeconds: 442,
        averageRating: 4.67,
        reviewCount: 9,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const complete = { ...baseline, messageCount: 2, favoriteCount: 3 };

  try {
    await harness.render({
      ...complete,
      apiBase: "https://api.example",
      enabled: true,
      creatorAnalyticsEnabled: true,
      fetcher,
    });
    assert.equal(
      requestedUrl,
      "https://api.example/api/worlds/world-a/activity",
    );
    assert.equal(requestedInit?.credentials, "include");
    assert.ok(requestedInit?.signal instanceof AbortSignal);
    assert.deepEqual(harness.current.activityStats, {
      ...complete,
      uniquePlayerCount: 18,
      averageSessionSeconds: 442,
      averageRating: 4.67,
    });
  } finally {
    await harness.unmount();
  }
});

test("creator activity stats keep empty-session and unrated states explicit", async () => {
  const harness = createHookHarness();
  const fetcher = (async () => new Response(JSON.stringify({
    data: {
      totalUniquePlayers: 0,
      avgSessionSeconds: 0,
      averageRating: 0,
      reviewCount: 0,
    },
  }), { status: 200 })) as typeof fetch;
  const complete = { ...baseline, messageCount: 2, favoriteCount: 3 };

  try {
    await harness.render({
      ...complete,
      apiBase: "",
      enabled: true,
      creatorAnalyticsEnabled: true,
      fetcher,
    });
    assert.deepEqual(harness.current.activityStats, {
      ...complete,
      uniquePlayerCount: 0,
      averageSessionSeconds: null,
      averageRating: null,
    });
  } finally {
    await harness.unmount();
  }
});

test("creator analytics survive a later public-counter hydration", async () => {
  const harness = createHookHarness();
  const requests = new Map<string, (response: Response) => void>();
  const fetcher = ((input: URL | RequestInfo) => new Promise<Response>((resolve) => {
    requests.set(String(input), resolve);
  })) as typeof fetch;
  const previewUrl = "/api/worlds/world-a?preview=true";
  const creatorUrl = "/api/worlds/world-a/activity";

  try {
    await harness.render({
      ...baseline,
      apiBase: "",
      enabled: true,
      creatorAnalyticsEnabled: true,
      fetcher,
    });
    assert.equal(requests.size, 2);

    requests.get(creatorUrl)?.(new Response(JSON.stringify({
      data: {
        totalUniquePlayers: 18,
        avgSessionSeconds: 442,
        averageRating: 4.67,
        reviewCount: 9,
      },
    }), { status: 200 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    requests.get(previewUrl)?.(new Response(JSON.stringify({
      data: { downloadCount: 12, messageCount: 34, favoriteCount: 56 },
    }), { status: 200 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(harness.current.activityStats, {
      worldId: "world-a",
      downloadCount: 12,
      messageCount: 34,
      favoriteCount: 56,
      uniquePlayerCount: 18,
      averageSessionSeconds: 442,
      averageRating: 4.67,
    });
  } finally {
    await harness.unmount();
  }
});

test("activity stats skip unnecessary requests and retain baseline data on supplementary failures", async (t) => {
  await t.test("disabled", async () => {
    const harness = createHookHarness();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await harness.render({ ...baseline, apiBase: "", enabled: false, fetcher });
      assert.equal(calls, 0);
      assert.deepEqual(harness.current.activityStats, baseline);
    } finally {
      await harness.unmount();
    }
  });

  await t.test("already complete", async () => {
    const harness = createHookHarness();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const complete = { ...baseline, messageCount: 2, favoriteCount: 3 };
    try {
      await harness.render({ ...complete, apiBase: "", enabled: true, fetcher });
      assert.equal(calls, 0);
      assert.deepEqual(harness.current.activityStats, complete);
    } finally {
      await harness.unmount();
    }
  });

  const failures: Array<[string, () => Promise<Response>]> = [
    ["non-OK response", async () => new Response(null, { status: 503 })],
    ["missing data", async () => new Response(JSON.stringify({}), { status: 200 })],
    ["invalid JSON", async () => new Response("not-json", { status: 200 })],
    ["network error", async () => { throw new Error("offline"); }],
    ["abort error", async () => { throw new DOMException("aborted", "AbortError"); }],
  ];

  for (const [name, response] of failures) {
    await t.test(name, async () => {
      const harness = createHookHarness();
      const fetcher = (async () => response()) as typeof fetch;
      try {
        await harness.render({ ...baseline, apiBase: "", enabled: true, fetcher });
        assert.deepEqual(harness.current.activityStats, baseline);
      } finally {
        await harness.unmount();
      }
    });
  }
});

test("selection changes abort the old request and suppress a stale response", async () => {
  const harness = createHookHarness();
  let resolveOld: ((response: Response) => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  const fetcher = ((_: URL | RequestInfo, init?: RequestInit) => {
    oldSignal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
  }) as typeof fetch;

  try {
    await harness.render({ ...baseline, apiBase: "", enabled: true, fetcher });
    const next: ActivityStats = {
      worldId: "world-b",
      downloadCount: 20,
      messageCount: 30,
      favoriteCount: 40,
    };
    await harness.render({ ...next, apiBase: "", enabled: true, fetcher });
    assert.equal(oldSignal?.aborted, true);

    resolveOld?.(new Response(JSON.stringify({
      data: { downloadCount: 999, messageCount: 999, favoriteCount: 999 },
    }), { status: 200 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(harness.current.activityStats, next);
  } finally {
    await harness.unmount();
  }
});

test("same-world prop refreshes replace stale remote counters", async () => {
  const harness = createHookHarness();
  const fetcher = (async () => new Response(JSON.stringify({
    data: { downloadCount: 11, messageCount: 21, favoriteCount: 31 },
  }), { status: 200 })) as typeof fetch;

  try {
    await harness.render({ ...baseline, apiBase: "", enabled: true, fetcher });
    assert.equal(harness.current.activityStats.downloadCount, 11);

    const refreshed: ActivityStats = {
      worldId: "world-a",
      downloadCount: 100,
      messageCount: 200,
      favoriteCount: 300,
    };
    await harness.render({ ...refreshed, apiBase: "", enabled: true, fetcher });
    assert.deepEqual(harness.current.activityStats, refreshed);
  } finally {
    await harness.unmount();
  }
});

test("favorite reconciliation updates known counts and resists an older preview response", async () => {
  const harness = createHookHarness();
  let resolvePreview: ((response: Response) => void) | undefined;
  const fetcher = (() => new Promise<Response>((resolve) => {
    resolvePreview = resolve;
  })) as typeof fetch;
  const item = { ...baseline, favoriteCount: 5 };

  try {
    await harness.render({ ...item, apiBase: "", enabled: true, fetcher });
    await act(async () => harness.current.reconcileFavoriteCount(true));
    assert.equal(harness.current.activityStats.favoriteCount, 6);

    resolvePreview?.(new Response(JSON.stringify({
      data: { downloadCount: 11, messageCount: 22, favoriteCount: 5 },
    }), { status: 200 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(harness.current.activityStats, {
      worldId: "world-a",
      downloadCount: 11,
      messageCount: 22,
      favoriteCount: 6,
    });

    await act(async () => harness.current.reconcileFavoriteCount(false));
    assert.equal(harness.current.activityStats.favoriteCount, 5);
  } finally {
    await harness.unmount();
  }
});

test("favorite reconciliation rehydrates when the initial count is unavailable", async () => {
  const harness = createHookHarness();
  const requests: Array<{
    signal: AbortSignal | undefined;
    resolve: (response: Response) => void;
  }> = [];
  const fetcher = ((_: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ signal: init?.signal ?? undefined, resolve });
  })) as typeof fetch;

  try {
    await harness.render({ ...baseline, apiBase: "", enabled: true, fetcher });
    assert.equal(requests.length, 1);

    await act(async () => harness.current.reconcileFavoriteCount(true));
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.signal?.aborted, true);

    requests[0]!.resolve(new Response(JSON.stringify({
      data: { downloadCount: 10, messageCount: 20, favoriteCount: 4 },
    }), { status: 200 }));
    requests[1]!.resolve(new Response(JSON.stringify({
      data: { downloadCount: 11, messageCount: 21, favoriteCount: 5 },
    }), { status: 200 }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(harness.current.activityStats, {
      worldId: "world-a",
      downloadCount: 11,
      messageCount: 21,
      favoriteCount: 5,
    });
  } finally {
    await harness.unmount();
  }
});

test("favorite overrides are scoped to one world when the selection changes", async () => {
  const harness = createHookHarness();
  const fetcher = (async () => new Response(JSON.stringify({
    data: { downloadCount: 22, messageCount: 33, favoriteCount: 9 },
  }), { status: 200 })) as typeof fetch;
  const first = { ...baseline, messageCount: 2, favoriteCount: 5 };

  try {
    await harness.render({ ...first, apiBase: "", enabled: true, fetcher });
    await act(async () => harness.current.reconcileFavoriteCount(true));
    assert.equal(harness.current.activityStats.favoriteCount, 6);

    const second: ActivityStats = {
      worldId: "world-b",
      downloadCount: 20,
      messageCount: undefined,
      favoriteCount: undefined,
    };
    await harness.render({ ...second, apiBase: "", enabled: true, fetcher });
    assert.deepEqual(harness.current.activityStats, {
      worldId: "world-b",
      downloadCount: 22,
      messageCount: 33,
      favoriteCount: 9,
    });
  } finally {
    await harness.unmount();
  }
});

test("authoritative favorite props take over after the local count is acknowledged", async () => {
  const harness = createHookHarness();
  const fetcher = (async () => new Response(null, { status: 200 })) as typeof fetch;
  const initial = { ...baseline, messageCount: 2, favoriteCount: 5 };

  try {
    await harness.render({ ...initial, apiBase: "", enabled: true, fetcher });
    await act(async () => harness.current.reconcileFavoriteCount(true));
    assert.equal(harness.current.activityStats.favoriteCount, 6);

    const acknowledged = { ...initial, favoriteCount: 6 };
    await harness.render({ ...acknowledged, apiBase: "", enabled: true, fetcher });
    assert.equal(harness.current.activityStats.favoriteCount, 6);

    const authoritative = { ...initial, favoriteCount: 7 };
    await harness.render({ ...authoritative, apiBase: "", enabled: true, fetcher });
    assert.equal(harness.current.activityStats.favoriteCount, 7);
  } finally {
    await harness.unmount();
  }
});
