import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInstance } from "i18next";
import { createWorldSchema, MAX_REQUEST_BODY_BYTES } from "@yumina/shared";
import {
  serializeWorldSavePayload,
  WorldSavePayloadTooLargeError,
  worldSaveErrorMessage,
  worldSaveValidationMessage,
  worldSaveExceptionMessage,
} from "./world-save-payload";

test("a large imported game's source saves when compiled cache pushes it over the API limit", () => {
  const source = "x".repeat(2_800_000);
  const compiled = { code: source, filesHash: "current", compilerVersion: 1 };
  const payload = {
    name: "3D game",
    schema: {
      entries: [{ content: "Keep this lore" }],
      variables: [{ id: "save", defaultValue: { cash: 20 } }],
      rootComponent: { entryFile: "index.tsx", files: { "index.tsx": source }, compiled },
    },
    baseUpdatedAt: "2026-09-04T12:00:00.000Z",
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > MAX_REQUEST_BODY_BYTES);
  const result = serializeWorldSavePayload(payload);
  assert.ok(Buffer.byteLength(result) <= MAX_REQUEST_BODY_BYTES);
  const saved = JSON.parse(result);
  assert.equal(saved.schema.rootComponent.compiled, undefined);
  assert.deepEqual(saved.schema.rootComponent.files, payload.schema.rootComponent.files);
  assert.deepEqual(saved.schema.entries, payload.schema.entries);
  assert.deepEqual(saved.schema.variables, payload.schema.variables);
  assert.equal(saved.baseUpdatedAt, payload.baseUpdatedAt);
  assert.equal(payload.schema.rootComponent.compiled, compiled);
});

test("small worlds retain their precompiled cache", () => {
  const payload = { schema: { rootComponent: { files: { "index.tsx": "source" }, compiled: { code: "compiled" } } } };
  assert.equal(serializeWorldSavePayload(payload), JSON.stringify(payload));
});

test("size checks use UTF-8 bytes, including source that contains Chinese text", () => {
  const payload = { schema: { rootComponent: { files: { "index.tsx": "做饭🍔" }, compiled: { code: "夜市🌙" } } } };
  const original = JSON.stringify(payload);
  const result = serializeWorldSavePayload(payload, original.length);
  assert.ok(Buffer.byteLength(original) > original.length);
  assert.equal(JSON.parse(result).schema.rootComponent.compiled, undefined);
  assert.equal(JSON.parse(result).schema.rootComponent.files["index.tsx"], "做饭🍔");
});

test("source that is still too large is rejected without truncating authored content", () => {
  const payload = { schema: { rootComponent: { files: { "index.tsx": "x".repeat(200) }, compiled: { code: "extra" } } } };
  const snapshot = JSON.stringify(payload);
  assert.throws(() => serializeWorldSavePayload(payload, 100), WorldSavePayloadTooLargeError);
  assert.equal(JSON.stringify(payload), snapshot);
  assert.throws(() => serializeWorldSavePayload({ schema: { entries: ["x".repeat(200)] } }, 100), WorldSavePayloadTooLargeError);
});

test("exact request limit is accepted", () => {
  const payload = { name: "刚好" };
  assert.equal(serializeWorldSavePayload(payload, Buffer.byteLength(JSON.stringify(payload))), JSON.stringify(payload));
});

test("save errors identify size, authentication and validation failures", () => {
  assert.match(worldSaveErrorMessage(413, undefined), /too large/);
  assert.match(worldSaveErrorMessage(401, {}), /Sign in again/);
  assert.match(worldSaveErrorMessage(400, { error: "Validation failed", details: { fieldErrors: { name: ["String is too long"] } } }), /World title: String is too long/);
  assert.equal(worldSaveErrorMessage(400, { error: "Rejected", message: "Upload the embedded asset first." }), "Upload the embedded asset first.");
  assert.match(worldSaveErrorMessage(502, null), /HTTP 502/);
});

test("an imported title over the shared limit explains the limit and actual length for create and update", () => {
  const payload = { name: "x".repeat(55), description: "Valid description", schema: {} };
  const before = structuredClone(payload);
  for (const existing of [false, true]) {
    assert.equal(worldSaveValidationMessage(payload, existing),
      "World title can have at most 50 characters; currently 55. Shorten it and save again.");
    assert.equal(worldSaveValidationMessage({ ...payload, name: "x".repeat(50) }, existing), null);
  }
  assert.deepEqual(payload, before);
});

test("a real server validation response identifies multiple fields using the submitted snapshot", () => {
  const payload = { name: "x".repeat(55), description: "x".repeat(10001) };
  const result = createWorldSchema.safeParse(payload);
  assert.equal(result.success, false);
  if (result.success) return;
  const message = worldSaveErrorMessage(400, { error: "Validation failed", details: result.error.flatten() }, { payload });
  assert.match(message, /World title.*50.*55/);
  assert.match(message, /Description.*10000.*10001/);
  assert.match(worldSaveErrorMessage(400, { error: "Validation failed", details: result.error.flatten() }), /at most 50 characters/);
  assert.doesNotMatch(worldSaveErrorMessage(400, { error: "Validation failed", details: result.error.flatten() }), /currently/);
});

test("non-field validation, unavailable responses, restrictions and connection errors remain actionable", () => {
  assert.match(worldSaveErrorMessage(400, { details: { fieldErrors: { language: ["Invalid language"] }, formErrors: ["Invalid world"] } }), /Language: Invalid language/);
  assert.match(worldSaveErrorMessage(400, { details: { formErrors: ["Invalid world"] } }), /Invalid world/);
  assert.match(worldSaveErrorMessage(403, { error: "Your account is restricted." }), /account is restricted/);
  assert.match(worldSaveErrorMessage(404, null), /no longer exists|no longer have access/);
  assert.match(worldSaveErrorMessage(429, null), /Too many save requests/);
  assert.match(worldSaveErrorMessage(429, { error: "Wait 45 seconds." }), /45 seconds/);
  assert.match(worldSaveErrorMessage(502, null), /temporarily unavailable.*502/);
  assert.match(worldSaveExceptionMessage(new TypeError("Load failed")), /connection/);
  assert.match(worldSaveExceptionMessage(new Error("Unexpected internal failure")), /unexpected error/);
  assert.match(worldSaveExceptionMessage(new WorldSavePayloadTooLargeError(6 * 1024 * 1024, MAX_REQUEST_BODY_BYTES)), /6.0 MB.*5.0 MB/);
});

test("save errors interpolate field names, limits and lengths in every supported UI language", async () => {
  const locales = ["en", "zh", "zh-Hant", "ja", "es"];
  const dictionaries = Object.fromEntries(locales.map(locale => [locale,
    JSON.parse(readFileSync(new URL(`../locales/${locale}/editor.json`, import.meta.url), "utf8")).saveErrors as Record<string, string>,
  ]));
  const reference = dictionaries.en!;
  const variables = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
  const instance = createInstance();
  await instance.init({ lng: "en", fallbackLng: "en", interpolation: { escapeValue: false },
    resources: Object.fromEntries(locales.map(locale => [locale, { editor: { saveErrors: dictionaries[locale] } }])),
  });
  for (const locale of locales) {
    const translated = dictionaries[locale]!;
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(reference).sort(), locale);
    for (const key of Object.keys(reference)) {
      assert.ok(translated[key]?.trim(), `${locale}: ${key}`);
      assert.deepEqual(variables(translated[key]!), variables(reference[key]!), `${locale}: ${key}`);
    }
    const t = (key: string, options: Record<string, unknown>) =>
      (instance.t as (key: string, options: Record<string, unknown>) => string)(key, { ...options, lng: locale });
    const error = worldSaveValidationMessage({ name: "x".repeat(55) }, false, { t });
    assert.equal(error, translated.tooLong!.replace("{{field}}", translated.field_name!).replace("{{limit}}", "50").replace("{{actual}}", "55"));
    assert.equal(worldSaveErrorMessage(401, null, { t }), translated.sessionExpired);
    assert.equal(worldSaveErrorMessage(403, { error: "Not authorized" }, { t }), translated.forbidden);
    assert.equal(worldSaveErrorMessage(403, { error: "Your account is restricted. You cannot create new worlds." }, { t }), translated.accountRestricted);
    assert.equal(worldSaveErrorMessage(404, { error: "World not found" }, { t }), translated.notFound);
    assert.equal(worldSaveErrorMessage(429, { error: "Too many requests. Please wait 45 seconds.", code: "RATE_LIMITED" }, { t }), translated.rateLimitedSeconds!.replace("{{seconds}}", "45"));
    assert.equal(worldSaveErrorMessage(429, { code: "RATE_LIMITED", retryAfter: 30 }, { t }), translated.rateLimitedSeconds!.replace("{{seconds}}", "30"));
    assert.equal(worldSaveExceptionMessage(new TypeError("Failed to fetch"), { t }), translated.network);
  }
});

test("field validation reports details on browsers without Object.hasOwn", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Object, "hasOwn")!;
  try {
    Object.defineProperty(Object, "hasOwn", { value: undefined, configurable: true });
    assert.match(worldSaveValidationMessage({ name: "x".repeat(55) }, false)!, /World title.*50.*55/);
  } finally {
    Object.defineProperty(Object, "hasOwn", descriptor);
  }
});
