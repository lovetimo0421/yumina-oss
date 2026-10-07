import assert from "node:assert/strict";
import test from "node:test";
import { PHONE_VIEW_MODE_STORAGE_KEY, VIEW_MODE_STORAGE_KEY, readStoredViewMode } from "./playtest-view-mode";

function withStorage(values: Record<string, string>, run: () => void) {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: (key: string) => values[key] ?? null } };
  try { run(); } finally { (globalThis as { window?: unknown }).window = original; }
}

test("a phone opens the phone preview; a laptop plays wide", () => {
  withStorage({}, () => {
    assert.equal(readStoredViewMode(true), "mobile");
    assert.equal(readStoredViewMode(false), "desktop");
  });
});

test("a laptop's desktop pick does not follow the creator onto a phone", () => {
  withStorage({ [VIEW_MODE_STORAGE_KEY]: "desktop" }, () => {
    assert.equal(readStoredViewMode(true), "mobile");
    assert.equal(readStoredViewMode(false), "desktop");
  });
  withStorage({ [VIEW_MODE_STORAGE_KEY]: "mobile" }, () => {
    assert.equal(readStoredViewMode(false), "mobile");
  });
});

test("a phone remembers its own pick", () => {
  withStorage({ [PHONE_VIEW_MODE_STORAGE_KEY]: "desktop" }, () => {
    assert.equal(readStoredViewMode(true), "desktop");
  });
});
