import assert from "node:assert/strict";
import test from "node:test";
import "../lib/vite-env.test-helpers";

const storage = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => [...storage.keys()][index] ?? null,
  removeItem: (key) => {
    storage.delete(key);
  },
  setItem: (key, value) => {
    storage.set(key, value);
  },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: localStorageStub,
});

const { useLibraryStore } = await import("./library");
type LibraryItem = ReturnType<typeof useLibraryStore.getState>["items"][number];

const existingItem = {
  libraryId: "library-1",
  worldId: "world-1",
  worldName: "Existing world",
  worldDescription: "",
  worldThumbnailUrl: null,
  worldStatus: "published",
  worldTags: [],
  worldIsNsfw: false,
  worldDownloadCount: 0,
  worldMessageCount: 0,
  creatorId: "creator-1",
  creatorName: "Creator",
  creatorUsername: null,
  creatorImage: null,
  addedAt: "2026-08-27T00:00:00.000Z",
  lastPlayedAt: null,
  lastSeenUpdateAt: null,
  hasUpdate: false,
} satisfies LibraryItem;

test("background library refresh keeps the rendered list and loading state stable", async () => {
  const originalFetch = globalThis.fetch;
  let finishRequest: ((response: Response) => void) | undefined;

  useLibraryStore.setState({
    items: [existingItem],
    loading: false,
    lastFetchedAt: Date.now(),
    total: 1,
    hasMore: false,
  });

  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    finishRequest = resolve;
  })) as typeof fetch;

  try {
    const refresh = useLibraryStore.getState().refreshLibrary();

    assert.equal(useLibraryStore.getState().loading, false);
    assert.deepEqual(useLibraryStore.getState().items, [existingItem]);

    finishRequest?.(new Response(JSON.stringify({ data: [existingItem], total: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await refresh;

    assert.equal(useLibraryStore.getState().loading, false);
    assert.deepEqual(useLibraryStore.getState().items, [existingItem]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("seeing an update clears the dot on the collapsed card and tells the server once", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  }) as typeof fetch;
  try {
    useLibraryStore.setState({
      items: [
        { ...existingItem, hasUpdate: true, siblingWorldIds: ["world-1", "world-1-deep"] },
        { ...existingItem, libraryId: "library-2", worldId: "world-2", hasUpdate: true },
      ],
    });

    // Opening a sibling variant clears the group's card, not unrelated cards.
    await useLibraryStore.getState().markUpdateSeen("world-1-deep");
    assert.deepEqual(calls, [{ url: "/api/library/world-1-deep/seen", method: "PATCH" }]);
    assert.deepEqual(useLibraryStore.getState().items.map((i) => i.hasUpdate), [false, true]);

    // Playing counts as seeing the update (the server baselines on last_played_at).
    useLibraryStore.getState().markPlayed("world-2");
    assert.deepEqual(useLibraryStore.getState().items.map((i) => i.hasUpdate), [false, false]);

    // A network failure must not reject: callers fire this without awaiting.
    globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await useLibraryStore.getState().markUpdateSeen("world-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
