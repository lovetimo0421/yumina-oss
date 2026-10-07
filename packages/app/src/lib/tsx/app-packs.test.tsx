import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_PACK_IDS, appPackSample, appPackSource, appPackSummaries, appPackVariableId, generateComposedIndex } from "@yumina/engine";
import { bundleAndCompile } from "./tsx-bundler";

/**
 * App packs are compiled by the same bundler that plays every card, so the
 * only proof that one works is to run it through that bundler: the composed
 * index must find each App's `app` export, and each App must render its
 * sample data without leaking "undefined" or "NaN" onto the screen.
 */

function apiWith(variables: Record<string, unknown>, language: string) {
  return () => ({
    variables,
    language,
    sendMessage: () => {},
    setVariable: () => {},
    patchVariables: () => Promise.resolve(),
    setComposerDraft: () => {},
  });
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

test("the composed index puts every App pack into one dock and keeps the user's root", () => {
  const files: Record<string, string> = {
    "__user-root.tsx": 'export default function Root() { return <main className="user-root">story</main>; }',
    "index.tsx": generateComposedIndex([...APP_PACK_IDS]),
  };
  const variables: Record<string, unknown> = {};
  for (const id of APP_PACK_IDS) {
    files[`_bundles/${id}/index.tsx`] = appPackSource(id, "zh");
    variables[appPackVariableId(id)] = appPackSample(id, "zh");
  }

  const result = bundleAndCompile({ files, entryFile: "index.tsx" }, apiWith(variables, "zh"));
  assert.equal(result.error, null, `bundle failed: ${result.error}`);
  const html = renderToStaticMarkup(createElement(result.Component!));
  assert.match(html, /class="user-root"/);
  assert.match(html, /role="toolbar"/);
  for (const { name } of appPackSummaries("zh")) {
    assert.ok(html.includes(`aria-label="${name}"`), `dock is missing ${name}`);
  }
});

test("an older bundle without `app` metadata still mounts as an overlay", () => {
  const files = {
    "__user-root.tsx": "export default function Root() { return <main>story</main>; }",
    "_bundles/legacy/index.tsx": 'export default function Legacy() { return <div className="legacy-overlay">old</div>; }',
    "index.tsx": generateComposedIndex(["legacy"]),
  };
  const result = bundleAndCompile({ files, entryFile: "index.tsx" }, apiWith({}, "en"));
  assert.equal(result.error, null, `bundle failed: ${result.error}`);
  const html = renderToStaticMarkup(createElement(result.Component!));
  assert.match(html, /legacy-overlay/);
  assert.doesNotMatch(html, /role="toolbar"/);
});

for (const lang of ["zh", "en", "es"]) {
  for (const id of APP_PACK_IDS) {
    test(`${id} renders its sample (${lang}) and an empty state`, () => {
      const code = appPackSource(id, lang);
      const variable = appPackVariableId(id);

      const full = bundleAndCompile({ files: { "index.tsx": code }, entryFile: "index.tsx" }, apiWith({ [variable]: appPackSample(id, lang) }, lang));
      assert.equal(full.error, null, `bundle failed: ${full.error}`);
      const text = visibleText(renderToStaticMarkup(createElement(full.Component!)));
      assert.ok(text.trim().length > 40, `${id} rendered almost nothing`);
      assert.doesNotMatch(text, /\bundefined\b|\bNaN\b|\[object Object\]/, `${id} leaks a raw value`);

      // Before the AI has written anything the variable holds its default.
      const empty = bundleAndCompile({ files: { "index.tsx": code }, entryFile: "index.tsx" }, apiWith({}, lang));
      const emptyText = visibleText(renderToStaticMarkup(createElement(empty.Component!)));
      assert.doesNotMatch(emptyText, /\bundefined\b|\bNaN\b|\[object Object\]/, `${id} empty state leaks a raw value`);
    });
  }
}
