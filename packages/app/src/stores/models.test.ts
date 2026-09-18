import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { useModelsStore } from "./models";
import { useCreditStore } from "@/edition/slots.state";
import { useUserProfileStore } from "./user-profile";

const originalFetch = globalThis.fetch;
const key = (id = "a", models = ["deepseek-old"]) => ({ id, provider: "custom", metadata: { models } });
const reply = (data: unknown) => Response.json({ data });
function select(id: string) {
  useUserProfileStore.setState({ profile: { preferences: { activeApiKeyId: id } } as never });
}
beforeEach(() => {
  useModelsStore.setState({ models: [], curated: [], loading: false, lastFetched: 0, lastSourceKey: "" });
  useCreditStore.setState({ provider: "private", lastFetched: Date.now() });
  select("a");
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("saved private catalogs refresh upstream and expose the cache while waiting", async () => {
  let finish: ((value: Response) => void) | undefined;
  let calls = 0;
  globalThis.fetch = (async (url) => {
    calls++;
    if (String(url).endsWith("/keys")) return reply([key()]);
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as typeof fetch;
  const request = useModelsStore.getState().fetchModels();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/deepseek-old");
  assert.equal(useModelsStore.getState().loading, false);
  await useModelsStore.getState().fetchModels();
  assert.equal(calls, 2, "duplicate opens share the pending refresh");
  assert.ok(finish, "a saved catalog must not prevent upstream refresh");
  finish(reply({ ok: true, provider: "custom", models: ["deepseek-new"] }));
  await request;
  assert.deepEqual(useModelsStore.getState().models.map((m) => m.id), ["custom/deepseek-new"]);
  await useModelsStore.getState().fetchModels();
  assert.equal(calls, 2, "fresh catalogs do not re-fetch");
});

for (const failure of ["network", "http", "empty", "invalid", "provider"]) {
  test(`upstream ${failure} failure keeps saved private models`, async () => {
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/keys")) return reply([key()]);
      if (failure === "network") throw new Error("offline");
      if (failure === "http") return new Response(null, { status: 503 });
      if (failure === "invalid") return new Response("not JSON");
      return reply({ ok: failure !== "provider", models: [] });
    }) as typeof fetch;
    await useModelsStore.getState().fetchModels();
    assert.deepEqual(useModelsStore.getState().models.map((m) => m.id), ["custom/deepseek-old"]);
    assert.equal(useModelsStore.getState().loading, false);
  });
}

test("expired memory cache queries upstream again even with saved models", async () => {
  let calls = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/keys")) return reply([key()]);
    calls++;
    return reply({ ok: true, models: [`new-${calls}`] });
  }) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  useModelsStore.setState({ lastFetched: Date.now() - 300_001 });
  await useModelsStore.getState().fetchModels();
  assert.equal(calls, 2);
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/new-2");
});

test("a freshly typed default survives an upstream TTL response that lacks it", async () => {
  globalThis.fetch = (async (url) => String(url).endsWith("/keys")
    ? reply([{ ...key(), metadata: { models: ["listed"], defaultModel: "hand-typed" } }])
    : reply({ ok: true, models: ["listed"] })) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  assert.deepEqual(useModelsStore.getState().models.map((m) => m.id), ["custom/listed", "custom/hand-typed"]);
});

test("late responses from an inactive key cannot replace the current catalog", async () => {
  let finishA: ((value: Response) => void) | undefined;
  const paths: string[] = [];
  globalThis.fetch = (async (url) => {
    const path = String(url);
    paths.push(path);
    if (path.endsWith("/keys")) return reply([key("a"), key("b", ["b-old"])]);
    if (path.includes("/a/")) return new Promise<Response>((resolve) => { finishA = resolve; });
    return reply({ ok: true, models: ["b-new"] });
  }) as typeof fetch;
  const a = useModelsStore.getState().fetchModels();
  await new Promise((resolve) => setImmediate(resolve));
  select("b");
  await useModelsStore.getState().fetchModels();
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/b-new");
  finishA!(reply({ ok: true, models: ["a-new"] }));
  await a;
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/b-new");
  assert.equal(useModelsStore.getState().lastSourceKey, "private:b");
  assert.equal(paths.filter((path) => path.includes("list-models")).length, 2);
});

test("missing active key refreshes fallback profiles without losing a failed profile", async () => {
  select("deleted");
  globalThis.fetch = (async (url) => {
    const path = String(url);
    if (path.endsWith("/keys")) return reply([key("a"), key("b", ["b-old"])]);
    if (path.includes("/a/")) return reply({ ok: true, models: ["a-new"] });
    throw new Error("offline");
  }) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  assert.deepEqual(useModelsStore.getState().models.map((m) => m.id), ["custom/a-new", "custom/b-old"]);
});

test("a failed profile read preserves the last rendered catalog", async () => {
  globalThis.fetch = (async (url) => String(url).endsWith("/keys")
    ? reply([key()]) : reply({ ok: true, models: ["new"] })) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  useModelsStore.setState({ lastFetched: 0 });
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  await useModelsStore.getState().fetchModels();
  assert.equal(useModelsStore.getState().models[0]?.id, "custom/new");
});
