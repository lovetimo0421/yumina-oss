import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import type { StateValidationAudit } from "@yumina/shared";
import { diagnosticSummary, readableBatch, readableLabels, variableLabel } from "../../../sandbox/extensions/state-update-guard/readable-output";
import { displayAudit, validationRecords } from "../../../sandbox/extensions/state-update-guard/audit-records";
import { guardLabels } from "../../../sandbox/extensions/state-update-guard/details";
import { guardSettingsLabels } from "../../../sandbox/extensions/state-update-guard/settings";

// Sandbox TSX has its own config; load its real automatic-JSX transform just as
// the existing guard navigation harness does, without opening a browser.
let vite: ViteDevServer;
let OutputComparison: typeof import("../../../sandbox/extensions/state-update-guard/readable-output").OutputComparison;
let StateGuardDetails: typeof import("../../../sandbox/extensions/state-update-guard/details").StateGuardDetails;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL("../../..", import.meta.url)), configFile: false,
    envFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true, watch: null }, esbuild: { jsx: "automatic" } });
  ({ OutputComparison } = await vite.ssrLoadModule("/sandbox/extensions/state-update-guard/readable-output.tsx"));
  ({ StateGuardDetails } = await vite.ssrLoadModule("/sandbox/extensions/state-update-guard/details.tsx"));
});
after(async () => { await vite?.close(); });

const uuid = "8a23ad63-c7ce-40db-b59b-e10113f81d21";

test("Guard surfaces use the same regional and case-insensitive language routing as the app", () => {
  for (const [input, expected] of [["zh-HK", "zh-Hant"], ["zh-MO", "zh-Hant"], ["zh-hant", "zh-Hant"],
    ["ZH-TW", "zh-Hant"], ["ZH-cn", "zh"], ["JA-jp", "ja"], ["ES-mx", "es"], ["fr", "en"]]) {
    assert.deepEqual(guardLabels(input), guardLabels(expected), input);
    assert.deepEqual(guardSettingsLabels(input), guardSettingsLabels(expected), input);
    assert.deepEqual(readableLabels(input), readableLabels(expected), input);
  }
});
const audit = (patch: Partial<StateValidationAudit> = {}): StateValidationAudit => ({
  version: 1, attemptId: "attempt-a", path: "send", outcome: "valid-updates", diagnostics: [],
  parsedCount: 1, correctionCount: 1, repaired: true, model: "story", apiKeyTier: "byok",
  startedAt: "2026-09-09T01:00:00Z", baselineFingerprint: "baseline", usageLogIds: [], ...patch,
});

test("readable batches recognize every supported requested operation without applying it", () => {
  const operations = ["set", "add", "subtract", "multiply", "toggle", "append", "merge", "push", "delete"]
    .map((operation) => ({ variableId: uuid, operation, value: operation === "merge" ? { health: 3 } : 2 }));
  assert.deepEqual(readableBatch(JSON.stringify({ status: "updated", stateChanges: operations })), { operations, none: false });
  const minimal = [{ variableId: uuid, operation: "toggle" }, { variableId: `${uuid}.item`, operation: "delete" }];
  assert.deepEqual(readableBatch(JSON.stringify({ stateChanges: minimal }))?.operations, minimal);
  const oversized = readableBatch(JSON.stringify({ stateChanges: Array.from({ length: 101 }, () => operations[0]) }));
  assert.equal(oversized?.operations.length, 100);
  assert.equal(oversized?.truncated, true);
});

test("readable batches support fenced JSON, maps and an explicit no-update result", () => {
  assert.deepEqual(readableBatch('```json\n{"stateChanges":{"health":0,"ready":false}}\n```'), {
    operations: [{ variableId: "health", operation: "set", value: 0 }, { variableId: "ready", operation: "set", value: false }], none: false,
  });
  for (const stateChanges of [[], {}]) assert.deepEqual(readableBatch(JSON.stringify({ status: "none", stateChanges })), { operations: [], none: true });
});

test("unreadable, ambiguous and contradictory output stays raw instead of inventing updates", () => {
  for (const raw of ["", "not JSON", "null", "[]", "{}", '{"stateChanges":null}', '{"stateChanges":5}',
    '{"stateChanges":[]}', '{"status":"updated","stateChanges":{}}',
    '{"status":"none","stateChanges":{"health":2}}', '{"stateChanges":[null]}',
    '{"stateChanges":[{"variableId":"health","operation":"execute","value":"code"}]}',
    '{"stateChanges":[{"variableId":"health","operation":"set"}]}',
    '{"stateChanges":[{"variableId":5,"operation":"set","value":2}]}',
    '{"stateChanges":[{"variableId":"health","operation":"toString","value":2}]}']) {
    assert.equal(readableBatch(raw), null, raw);
  }
});

test("variable display uses saved names with nested paths and abbreviates unknown UUIDs", () => {
  assert.equal(variableLabel(`${uuid}.weapons[0]`, { [uuid]: "Inventory" }), "Inventory.weapons[0]");
  assert.equal(variableLabel(`${uuid}.health`), "Variable 8a23ad63.health");
  assert.equal(variableLabel("health"), "health");
  assert.equal(variableLabel("toString", {}), "toString");
  assert.equal(variableLabel(uuid, undefined, "es-MX"), "Variable 8a23ad63");
  for (const language of ["en", "zh-CN", "zh-TW", "zh-Hant", "ja-JP", "es-ES", "fr"]) {
    assert.equal(readableLabels(language).length, 28);
    assert.ok(diagnosticSummary(["missing_receipt", "count_mismatch", "invalid_correction", "malformed_operation", "provider_error"], language).every(Boolean));
  }
  assert.equal(diagnosticSummary(["malformed_operation", "unknown_variable"]).length, 1);
  assert.deepEqual(diagnosticSummary(["read_only_correction_ignored"]), []);
  assert.deepEqual(diagnosticSummary(["read_only_correction_ignored", "invalid_correction"]), diagnosticSummary(["invalid_correction"]));
  assert.deepEqual(diagnosticSummary(["incomplete_json", "incomplete_patch", "incompatible_value", "not_writable", "contradictory_none", "missing_state_changes", "missing_colon"]), ["Some update instructions could not be read safely."]);
});

test("output comparison orders original before correction, renders readable names and escapes model HTML", () => {
  const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const record = audit({ diagnostics: ["missing_receipt"], originalRaw: JSON.stringify({ stateChanges: { [uuid]: 100 } }),
    correctedBatch: JSON.stringify({ stateChanges: [{ variableId: uuid, operation: "subtract", value: attack }] }), variableNames: { [uuid]: "Health" } });
  const dom = new JSDOM(renderToStaticMarkup(createElement(OutputComparison, { audit: record })));
  try {
    const sections = dom.window.document.querySelectorAll("section");
    assert.deepEqual([...sections].map((section) => section.querySelector("h4")!.textContent), ["Before correction", "After correction"]);
    assert.equal(sections[0]!.querySelector("li")!.textContent, "Health: set to 100");
    assert.equal(sections[1]!.querySelector("li")!.textContent, `Health: decrease by ${attack}`);
    assert.equal(dom.window.document.querySelector("img,script"), null);
    assert.match(dom.window.document.body.textContent!, /requested operations, not proof/);
    assert.match(sections[0]!.textContent!, /required update confirmation/);
    assert.equal(dom.window.document.querySelectorAll("details[open]").length, 0);
  } finally { dom.window.close(); }
});

test("comparison distinguishes older missing originals, empty model output, no correction and shortened previews", () => {
  const render = (patch: Partial<StateValidationAudit>) => renderToStaticMarkup(createElement(OutputComparison, { audit: audit(patch) }));
  assert.match(render({ correctionCount: 0 }), /Original reply passed validation.*Original response was not saved/s);
  assert.match(render({ originalRaw: "", correctedBatch: "" }), /The model did not provide any output/);
  assert.match(render({ originalRaw: "broken JSON", originalRawTruncated: true }), /No readable structured update list.*Output preview shortened/s);
  assert.match(render({ correctedBatch: '{"status":"none","stateChanges":[]}' }), /explicitly requested no updates/);
  assert.match(render({ correctedBatch: JSON.stringify({ stateChanges: Array.from({ length: 101 }, () => ({ variableId: "health", operation: "add", value: 1 })) }) }), /Output preview shortened/);
});

test("valid bracket updates show one successful original check, not a failed JSON preview or a repair", () => {
  const raw = `You reach the shelter.\n${Array.from({ length: 8 }, (_, i) => `[stat-${i}: +1]`).join("\n")}\n<yumina-state version="1" status="updated" count="8" />`;
  const dom = new JSDOM(renderToStaticMarkup(createElement(OutputComparison, { audit: audit({
    originalRaw: raw, correctionCount: 0, repaired: false, parsedCount: 8,
  }) })));
  try {
    assert.deepEqual([...dom.window.document.querySelectorAll("h4")].map((node) => node.textContent), ["Original reply"]);
    const text = dom.window.document.body.textContent!;
    assert.match(text, /Original reply passed validation/);
    assert.match(text, /Recognized update commands: 8/);
    assert.match(text, /No correction model was called/);
    assert.doesNotMatch(text, /No readable structured|Before correction|After correction/);
    assert.equal(dom.window.document.querySelector("pre")!.textContent, raw);
  } finally { dom.window.close(); }
});

test("zero corrections never implies a successful check, and explicit none remains distinct from missing output", () => {
  const render = (patch: Partial<StateValidationAudit>) => renderToStaticMarkup(createElement(OutputComparison, { audit: audit({ correctionCount: 0, repaired: false, ...patch }) }));
  for (const outcome of ["failed", "cancelled", "stale", "validating", "repairing", "not-required"] as const) {
    const html = render({ outcome, diagnostics: ["provider_error"], originalRaw: "partial output" });
    assert.doesNotMatch(html, /passed validation|No correction was needed|After correction/);
    assert.match(html, /No correction was performed/);
  }
  const html = render({ outcome: "explicit-none", parsedCount: 0, originalRaw: '<yumina-state version="1" status="none" />' });
  assert.match(html, /explicitly requested no updates/);
  assert.match(html, /No correction model was called/);
  assert.doesNotMatch(html, /No readable structured|did not provide any output/);
});

test("simple statuses stay truthful for every outcome and keep model roles in closed technical details", () => {
  for (const [outcome, count, expected] of [
    ["valid-updates", 0, "No fix needed"], ["valid-updates", 1, "Fixed"],
    ["explicit-none", 0, "No fix needed"], ["explicit-none", 1, "Fixed"], ["not-required", 0, "No fix needed"],
    ["failed", 1, "Failed"], ["cancelled", 1, "Cancelled"], ["stale", 1, "Interrupted / stale"],
    ["validating", 0, "Checking"], ["repairing", 1, "Correcting"],
  ] as const) {
    const dom = new JSDOM(renderToStaticMarkup(createElement(StateGuardDetails, { records: [audit({ outcome, correctionCount: count, startedAt: new Date().toISOString() })] })));
    try {
      assert.equal(dom.window.document.querySelector("section > p")!.textContent, expected);
      assert.equal(dom.window.document.querySelectorAll("details[open]").length, 0);
      assert.match(dom.window.document.querySelector("details")!.textContent!, /Story model: story/);
    } finally { dom.window.close(); }
  }
});

test("simple status and technical model labels are localized together", () => {
  for (const [language, corrected, unchanged, story, correction] of [
    ["en", "Fixed", "No fix needed", "Story model", "Correction model"],
    ["zh-CN", "已修复", "无需修复", "剧情模型", "修正模型"],
    ["zh-TW", "已修復", "無需修復", "劇情模型", "修正模型"],
    ["ja-JP", "修正済み", "修正不要", "ストーリーモデル", "修正モデル"],
    ["es-ES", "Corregido", "No necesita corrección", "Modelo de historia", "Modelo de corrección"],
  ]) {
    const dom = new JSDOM(renderToStaticMarkup(createElement(StateGuardDetails, { language, records: [audit({ correctionCount: 0 }), audit({ attemptId: "corrected", correctionModel: "gemini" })] })));
    try {
      assert.deepEqual([...dom.window.document.querySelectorAll("section > p:first-child")].map((node) => node.textContent), [corrected, unchanged]);
      assert.ok(dom.window.document.body.textContent!.includes(`${story}: story`));
      assert.ok(dom.window.document.body.textContent!.includes(`${correction}: gemini`));
    } finally { dom.window.close(); }
  }
});

test("Guard history dates follow the selected UI language rather than the browser default", async () => {
  const { StateGuardDetails } = await vite.ssrLoadModule("/sandbox/extensions/state-update-guard/details.tsx");
  const record = audit({ correctionCount: 0 });
  for (const language of ["zh-Hant", "ja", "es"]) {
    const dom = new JSDOM(renderToStaticMarkup(createElement(StateGuardDetails, { records: [record], language })));
    try {
      assert.ok(dom.window.document.body.textContent!.includes(new Date(record.startedAt).toLocaleString(language)), language);
    } finally { dom.window.close(); }
  }
});

test("audit enrichment prefers historical names and original while preserving source objects", () => {
  const source = audit({ originalRaw: "saved-original", variableNames: { [uuid]: "Historical health" } });
  const enriched = displayAudit(source, "fallback-original", [{ id: uuid, name: "Renamed health" }, { id: "energy", name: "Energy" }]);
  assert.equal(enriched.originalRaw, "saved-original");
  assert.deepEqual(enriched.variableNames, { [uuid]: "Historical health", energy: "Energy" });
  assert.deepEqual(source.variableNames, { [uuid]: "Historical health" });
  assert.equal(source.originalRawTruncated, undefined);
  assert.equal(displayAudit(audit(), 123).originalRaw, undefined);
  assert.equal(displayAudit(audit(), "x".repeat(65537)).originalRaw!.length, 65536);
  assert.equal(displayAudit(audit(), "x".repeat(65537)).originalRawTruncated, true);
  assert.equal(displayAudit(audit({ originalRaw: "short", originalRawTruncated: true })).originalRawTruncated, true);
});

test("history only recovers originals from the matching swipe attempt and never a combined continuation", () => {
  const records = validationRecords([{ rawContent: "message-raw-must-not-be-inferred", stateValidation: audit({ attemptId: "latest" }), swipes: [
    { stateValidation: audit(), rawContent: "original-a" },
    { stateValidation: audit({ attemptId: "b", path: "regenerate" }), rawContent: "original-b" },
    { stateValidation: audit({ attemptId: "continued", path: "continue" }), rawContent: "original-and-continuation" },
    { stateValidation: { version: 2, attemptId: "future" }, rawContent: "unsupported" },
  ] }, { stateValidation: audit({ outcome: "failed" }) }], [{ id: uuid, name: "Health" }]);
  assert.equal(records.length, 4);
  const byId = new Map(records.map((record) => [record.attemptId, record]));
  assert.equal(byId.get("attempt-a")!.originalRaw, "original-a");
  assert.equal(byId.get("attempt-a")!.outcome, "failed");
  assert.equal(byId.get("b")!.originalRaw, "original-b");
  assert.equal(byId.get("latest")!.originalRaw, undefined);
  assert.equal(byId.get("continued")!.originalRaw, undefined);
  assert.equal(displayAudit(audit({ path: "continue", originalRaw: "segment-only" }), "combined").originalRaw, "segment-only");
});
