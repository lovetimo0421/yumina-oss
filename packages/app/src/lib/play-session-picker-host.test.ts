import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function findHostMounts(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findHostMounts(path);
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) return [];

    const contents = readFileSync(path, "utf8");
    return /<PlaySessionPickerHost\s*\/>/.test(contents)
      ? [relative(srcRoot, path).replaceAll("\\", "/")]
      : [];
  });
}

test("the app shell is the only owner of the global play session picker host", () => {
  assert.deepEqual(findHostMounts(srcRoot), ["components/layout/app-shell.tsx"]);
});

test("play and manage sessions share the same modal effects", () => {
  const picker = readFileSync(join(srcRoot, "components/session-picker-modal.tsx"), "utf8");
  const manager = readFileSync(
    join(srcRoot, "features/sessions/session-manager-modal.tsx"),
    "utf8",
  );

  for (const sharedStyle of [
    "SESSION_MODAL_BACKDROP_CLASS",
    "SESSION_MODAL_SURFACE_CLASS",
    "SESSION_MODAL_GROUP_CLASS",
  ]) {
    assert.match(picker, new RegExp(`className=.*${sharedStyle}`));
    assert.match(manager, new RegExp(`className=.*${sharedStyle}`));
  }
});
