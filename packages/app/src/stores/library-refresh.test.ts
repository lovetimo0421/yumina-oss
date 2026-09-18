import assert from "node:assert/strict";
import test from "node:test";

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
