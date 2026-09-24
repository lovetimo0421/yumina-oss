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

test("a denied local-network permission short-circuits detection without probing", async () => {
  let probes = 0;
  const fetchImpl = (async () => { probes += 1; throw new TypeError("Failed to fetch"); }) as typeof fetch;
  await withBrowser({ "loopback-network": "denied" }, fetchImpl, async () => {
    assert.deepEqual(await detectLocalRuntime(), { status: "denied" });
  });
  assert.equal(probes, 0);
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
