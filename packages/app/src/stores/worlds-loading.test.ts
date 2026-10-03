import assert from "node:assert/strict";
import test from "node:test";
import { loadClientModule } from "../lib/feed-beacon.test-helpers";

const i18n = { language: "en", t: (key: string) => key };
const { useWorldsStore } = loadClientModule<typeof import("./worlds")>(new URL("./worlds.ts", import.meta.url), {
  "@/lib/i18n": i18n,
  "@/lib/feedback": { feedback: { error: () => {} } },
  "./library": { useLibraryStore: { getState: () => ({ invalidate: () => {} }) } },
});

test("world lists isolate scopes, coalesce background requests, and discard stale responses", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLang = i18n.language;
  const pending: { url: string; finish: (response: Response) => void }[] = [];
  globalThis.fetch = ((url) => new Promise<Response>((finish) => {
    pending.push({ url: String(url), finish });
  })) as typeof fetch;
  const state = () => useWorldsStore.getState();
  const respond = (index: number, id: string) => pending[index]!.finish(Response.json({ data: [{ id }] }));
  state().clear();
  i18n.language = "en";
  t.after(() => { globalThis.fetch = originalFetch; i18n.language = originalLang; state().clear(); });

  const options = { scope: "library", userId: "alice" } as const;
  const first = state().fetchWorlds(options);
  assert.strictEqual(state().fetchWorlds(options), first);
  assert.equal(pending.length, 1);
  assert.equal(new URL(pending[0]!.url, "https://yumina.test").searchParams.get("scope"), "library");
  respond(0, "saved"); await first;
  await state().fetchWorlds(options);
  assert.equal(pending.length, 1, "fresh scoped results should be reused");
  await state().fetchWorlds({ ...options, worldId: "saved" });
  await state().fetchWorlds(options);
  assert.equal(pending.length, 1, "opening a cached card and returning must not refetch or flash a spinner");
  assert.equal(state().loading, false);

  useWorldsStore.setState({ lastFetchedAt: Date.now() - 40_000 });
  const stale = state().fetchWorlds(options);
  assert.equal(state().loading, false, "refresh must not collapse an existing list");
  assert.strictEqual(state().fetchWorlds(options), stale);
  assert.equal(pending.length, 2, "stale refresh must also deduplicate");
  respond(1, "refreshed"); await stale;

  const full = state().fetchWorlds();
  assert.equal(pending.length, 3, "a scoped result must not masquerade as the full catalogue");
  assert.equal(new URL(pending[2]!.url, "https://yumina.test").searchParams.has("scope"), false);
  i18n.language = "ja";
  const japanese = state().fetchWorlds(options);
  respond(3, "japanese"); await japanese;
  respond(2, "late-english"); await full;
  assert.equal(state().worlds[0]!.id, "japanese");

  const direct = state().fetchWorlds({ ...options, worldId: "linked-world" });
  assert.equal(new URL(pending[4]!.url, "https://yumina.test").searchParams.get("worldId"), "linked-world");
  state().clear();
  respond(4, "previous-account"); await direct;
  assert.deepEqual(state().worlds, [], "an in-flight response must not restore signed-out data");
});
