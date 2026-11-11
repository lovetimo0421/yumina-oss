import assert from "node:assert/strict";
import test from "node:test";
import { detectLocalRuntime, loopbackPermission } from "./detect";

function withBrowser(
  permissions: Record<string, PermissionState> | null,
  fetchImpl: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: permissions === null ? {} : {
      permissions: {
        query: async ({ name }: { name: string }) => {
          if (!(name in permissions)) throw new TypeError(`unknown permission ${name}`);
          return { state: permissions[name] };
        },
      },
    },
  });
  globalThis.fetch = fetchImpl;
  return run().finally(() => {
    if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
    else delete (globalThis as { navigator?: unknown }).navigator;
    globalThis.fetch = realFetch;
  });
}

test("a denied local-network permission is reported when nothing answers", async () => {
  const fetchImpl = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  await withBrowser({ "loopback-network": "denied" }, fetchImpl, async () => {
    assert.deepEqual(await detectLocalRuntime(), { status: "denied" });
  });
});

/** A machine where only LM Studio runs, answering its native model list. */
function lmStudioOnly(models: unknown[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "http://127.0.0.1:1234/api/v1/models") return Response.json({ models });
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
}

const QWEN = {
  type: "llm",
  key: "qwen/qwen3.8-27b",
  display_name: "Qwen3.8 27B",
  max_context_length: 262144,
  loaded_instances: [{ id: "qwen/qwen3.8-27b", config: { context_length: 262144 } }],
  capabilities: { reasoning: { allowed_options: ["off", "on"], default: "on" } },
};

test("a denied permission doesn't hide a runtime that answers", async () => {
  // A page served from this machine reaches its own ports without the
  // permission; some embedded browsers report it denied regardless.
  await withBrowser({ "loopback-network": "denied" }, lmStudioOnly([QWEN]), async () => {
    const result = await detectLocalRuntime();
    assert.equal(result.status, "ready");
  });
});

test("LM Studio lists chat models only, loaded first, with the context they run at", async () => {
  const models = [
    { type: "llm", key: "mistral-7b", max_context_length: 8192, loaded_instances: [] },
    { type: "embedding", key: "text-embedding-nomic-embed-text-v1.5", max_context_length: 2048, loaded_instances: [] },
    QWEN,
    { type: "llm", key: "cydonia-22b", max_context_length: 131072, loaded_instances: [] },
  ];
  await withBrowser({ "loopback-network": "granted" }, lmStudioOnly(models), async () => {
    const result = await detectLocalRuntime();
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.equal(result.runtime.kind, "lmstudio");
    assert.deepEqual(result.models, [
      // Loaded: the window the player loaded it at.
      { id: "qwen/qwen3.8-27b", name: "Qwen3.8 27B", loaded: true, contextLength: 262144, reasoningOptions: ["off", "on"] },
      // Not loaded: the window the bridge will load it at, capped by the model.
      { id: "mistral-7b", loaded: false, contextLength: 8192 },
      { id: "cydonia-22b", loaded: false, contextLength: 32768 },
    ]);
  });
});

test("LM Studio 0.3 is read through its beta list", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "http://127.0.0.1:1234/api/v1/models") return new Response("Unexpected endpoint", { status: 404 });
    if (url === "http://127.0.0.1:1234/api/v0/models") {
      return Response.json({ data: [
        { id: "nomic-embed", type: "embeddings", state: "not-loaded" },
        { id: "llama-3.1-8b", type: "llm", state: "not-loaded", max_context_length: 131072 },
        { id: "qwen2-vl-7b", type: "vlm", state: "loaded", loaded_context_length: 16384 },
      ] });
    }
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  await withBrowser({ "loopback-network": "granted" }, fetchImpl, async () => {
    const result = await detectLocalRuntime();
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.deepEqual(result.models, [
      { id: "qwen2-vl-7b", loaded: true, contextLength: 16384 },
      // No load endpoint before 0.4, so no promise about the window.
      { id: "llama-3.1-8b", loaded: false },
    ]);
  });
});

test("an empty Ollama doesn't shadow an LM Studio with models", async () => {
  // Ollama starts with Windows; first-found handed LM Studio players an empty runtime.
  const lmStudio = lmStudioOnly([QWEN]);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "http://127.0.0.1:11434/api/tags") return Response.json({ models: [] });
    return lmStudio(input, init);
  }) as typeof fetch;
  await withBrowser({ "loopback-network": "granted" }, fetchImpl, async () => {
    const result = await detectLocalRuntime();
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.deepEqual(result.runtimes.map((r) => r.runtime.kind), ["lmstudio"]);
  });
});

test("Ollama and LM Studio running together are both served", async () => {
  // Finding LM Studio must not cost the player their Ollama models.
  const lmStudio = lmStudioOnly([QWEN]);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "http://127.0.0.1:11434/api/tags") return Response.json({ models: [{ model: "qwen3.5:9b" }] });
    return lmStudio(input, init);
  }) as typeof fetch;
  await withBrowser({ "loopback-network": "granted" }, fetchImpl, async () => {
    const result = await detectLocalRuntime();
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    // The one with a model already loaded leads; both are there.
    assert.deepEqual(result.runtimes.map((r) => r.runtime.kind), ["lmstudio", "ollama"]);
    assert.deepEqual(result.models.map((m) => m.id), ["qwen/qwen3.8-27b", "qwen3.5:9b"]);
  });
});

test("older Chromes are read through local-network-access", async () => {
  await withBrowser({ "local-network-access": "granted" }, fetch, async () => {
    assert.equal(await loopbackPermission(), "granted");
  });
});

test("browsers without the permission API are not gated", async () => {
  await withBrowser(null, fetch, async () => {
    assert.equal(await loopbackPermission(), "unknown");
  });
});

test("nothing listening still reads as none once the permission is granted", async () => {
  const fetchImpl = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  await withBrowser({ "loopback-network": "granted" }, fetchImpl, async () => {
    assert.deepEqual(await detectLocalRuntime(), { status: "none" });
  });
});
