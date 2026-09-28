import assert from "node:assert/strict";
import test from "node:test";
import { scopeStorageKey, writeWorldStorage } from "./world-storage";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: Storage = {
    get length() { return values.size; },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
  };
  return { storage, values };
}

test("failed gallery writes preserve every existing key, including other worlds and sessions", () => {
  const initial = {
    "yumina:local:world-a:gallery:session-1": "previous gallery",
    "yumina:local:world-a:gallery:session-2": "another session",
    "yumina:local:world-b:gallery": "another world's much larger saved gallery",
    "account-preference": "keep",
  };
  const { storage, values } = memoryStorage(initial);
  storage.setItem = () => { throw new DOMException("Storage full", "QuotaExceededError"); };
  try { writeWorldStorage(storage, "yumina:local:world-a:gallery:session-1", "new image"); } catch { /* expected */ }
  assert.deepEqual(Object.fromEntries(values), initial);
});

test("quota failure rejects the creator's save chain instead of marking unsaved images persisted", async () => {
  const { storage } = memoryStorage();
  storage.setItem = () => { throw new DOMException("Storage full", "QuotaExceededError"); };
  let persisted = false;
  const save = Promise.resolve()
    .then(() => writeWorldStorage(storage, "yumina:local:w:gallery:s", "image"))
    .then(() => { persisted = true; });
  await assert.rejects(save, /Storage full/);
  assert.equal(persisted, false);
});

test("blocked browser storage preserves the original error and does not retry", () => {
  const { storage } = memoryStorage();
  const error = new DOMException("Storage access blocked", "SecurityError");
  let attempts = 0;
  storage.setItem = () => { attempts++; throw error; };
  assert.throws(() => writeWorldStorage(storage, "yumina:local:w:key", "value"), (e) => e === error);
  assert.equal(attempts, 1);
});

test("successful writes resolve void and replace only the requested key", () => {
  const { storage, values } = memoryStorage({ other: "keep", target: "old" });
  assert.equal(writeWorldStorage(storage, "target", "new"), undefined);
  assert.deepEqual(Object.fromEntries(values), { other: "keep", target: "new" });
});

test("SDK and compatibility-shim keys remain confined to their world", () => {
  assert.equal(scopeStorageKey("a", "gallery:s"), "yumina:local:a:gallery:s");
  assert.equal(scopeStorageKey("a", "yumina:local:a:gallery"), "yumina:local:a:gallery");
  assert.equal(scopeStorageKey("a", "yumina:session:a:gallery"), "yumina:session:a:gallery");
  for (const key of ["yumina:local:b:gallery", "yumina:session:b:gallery", "yumina:local:ab:gallery", "yumina:auth"]) {
    assert.equal(scopeStorageKey("a", key), `yumina:local:a:${key}`);
  }
});

test("adding a session ID to a local key does not synchronize two devices", () => {
  const pc = memoryStorage().storage;
  const phone = memoryStorage().storage;
  const key = scopeStorageKey("w", "gallery:same-session");
  writeWorldStorage(pc, key, "PC image");
  assert.equal(phone.getItem(key), null);
  writeWorldStorage(phone, key, "phone image");
  assert.equal(pc.getItem(key), "PC image");
  assert.equal(phone.getItem(key), "phone image");
});
