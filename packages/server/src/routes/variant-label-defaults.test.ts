import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const worldsSource = readFileSync(fileURLToPath(new URL("./worlds.ts", import.meta.url)), "utf8");
const variantBarSource = readFileSync(
  fileURLToPath(new URL("../../../app/src/features/editor/variant-tab-bar.tsx", import.meta.url)),
  "utf8",
);

function createVariantRoute() {
  const start = worldsSource.indexOf('worldRoutes.post("/:id/create-variant"');
  assert.notEqual(start, -1, "create-variant route must remain discoverable by this guard");
  const end = worldsSource.indexOf("worldRoutes.", start + 40);
  return worldsSource.slice(start, end === -1 ? undefined : end);
}

test("create-variant accepts a request with no label", () => {
  // The editor sends no label for a variant in a new language, so a required
  // label would break variant creation outright.
  const route = createVariantRoute();
  assert.doesNotMatch(
    route,
    /label is required/,
    "an omitted label must no longer be rejected",
  );
  assert.doesNotMatch(
    route,
    /label cannot be empty/,
    "a blank label must no longer be rejected",
  );
});

test("a blank label is stored as NULL, not as an empty string", () => {
  // NULL is what every picker treats as "author expressed no preference" and
  // falls back to the variant's own title; "" would be a label that renders
  // nothing.
  assert.match(
    createVariantRoute(),
    /const label = \(body\.label \?\? ""\)\.trim\(\)\.slice\(0, 100\) \|\| null;/,
    "blank labels must normalize to null",
  );
});

test("linking a world into a language group no longer stamps a language name on it", () => {
  // This is where every "English" / "Español" row in the picker came from.
  const route = createVariantRoute();
  assert.doesNotMatch(
    route,
    /updates\.variantLabel\s*=/,
    "the source world's label must be left alone when it joins a group",
  );
  assert.doesNotMatch(
    route,
    /sourceNeedsLabel/,
    "the derive-a-label-from-language branch must be gone",
  );
});

test("the editor only numbers a variant when its language already exists in the group", () => {
  // "Variant 3" is the one case a title cannot cover: two variants sharing a
  // language. Everywhere else the title is the better, self-updating label.
  assert.match(
    variantBarSource,
    /const sameLanguageExists = variants\.some\(/,
    "the editor must check for a same-language sibling before numbering",
  );
  assert.match(
    variantBarSource,
    /sameLanguageExists\s*\?[\s\S]{0,120}variantBar\.variantPrefix[\s\S]{0,40}:\s*"";/,
    "a variant in a brand-new language must be created with no label",
  );
});
