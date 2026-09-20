import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtensionIcon } from "./extension-icon";
import { validateExtensionsSearch } from "./extension-search";

test("guard keeps an explicit opt-in detail link alongside the catalog", () => {
  assert.deepEqual(validateExtensionsSearch({ tab: "manage", extension: "state-update-guard" }), {
    tab: "manage", extension: "state-update-guard",
  });
  assert.deepEqual(validateExtensionsSearch({ tab: "discover" }), { tab: "discover", extension: undefined });
});

test("catalog renders the guard shield, memory brain and unknown-icon fallback", () => {
  for (const [name, expected] of [["shield-check", "lucide-shield-check"], ["brain", "lucide-brain"], ["unknown", "lucide-blocks"]]) {
    const markup = renderToStaticMarkup(createElement(ExtensionIcon, { name, className: "catalog-icon" }));
    assert.ok(markup.includes(expected), `${name} must render ${expected}`);
    assert.ok(markup.includes("catalog-icon"));
  }
});

test("deep links reject unknown keys, URL/path injection and non-string values", () => {
  for (const extension of ["missing", "../install", "https://example.com", "", ["state-update-guard"], null, 1, {}]) {
    assert.equal(validateExtensionsSearch({ extension }).extension, undefined);
  }
  assert.equal(validateExtensionsSearch({ tab: "unknown" }).tab, undefined);
});

test("existing extension detail links use the same registry allowlist", () => {
  assert.equal(validateExtensionsSearch({ extension: "session-memory-summary" }).extension, "session-memory-summary");
});

test("route opens the existing preview and never auto-installs a linked extension", () => {
  const route = readFileSync(new URL("../../routes/app/extensions.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./extensions-page.tsx", import.meta.url), "utf8");
  assert.match(route, /validateSearch: validateExtensionsSearch/);
  assert.match(page, /fetchDetail\(linkedExtension\)/);
  assert.match(page, /if \(!active\) return/);
  assert.match(page, /openPreview\(detail, "overview"\)/);
  assert.match(page, /toast\.error/);
  assert.doesNotMatch(page, /\.install\(/);
});

test("sandbox message edits and swipes immediately update validation status", () => {
  const renderer = readFileSync(new URL("../chat/world-renderer.tsx", import.meta.url), "utf8");
  assert.match(renderer, /stateValidation: Object\.hasOwn\(data, "stateValidation"\)/);
  assert.match(renderer, /store\.updateMessage\(messageId, data\)/, "edits use the server response, including cleared audit and existing main fields");
  const route = readFileSync(new URL("../../../../server/src/routes/messages.ts", import.meta.url), "utf8");
  assert.match(route, /\.set\(\{ \.\.\.messageContentUpdate\(body\.content\), stateValidation: null \}\)/);
});

test("the linked preview has dialog semantics and keyboard focus containment", () => {
  const modal = readFileSync(new URL("./extension-preview-modal.tsx", import.meta.url), "utf8");
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-label=\{localized\.name\}/);
  assert.match(modal, /modalRef\.current\?\.focus\(\)/);
  assert.match(modal, /e\.shiftKey/);
  assert.match(modal, /previouslyFocused\.focus\(\)/);
});
