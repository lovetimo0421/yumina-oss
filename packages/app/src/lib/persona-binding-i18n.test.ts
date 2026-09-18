import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const locales = ["en", "zh", "zh-Hant", "ja", "es"] as const;

function loadBinding(locale: (typeof locales)[number]): Record<string, string> {
  const file = new URL(`../locales/${locale}/profile.json`, import.meta.url);
  const profile = JSON.parse(readFileSync(file, "utf8")) as {
    persona?: { binding?: Record<string, unknown> };
  };
  const binding = profile.persona?.binding;
  assert.ok(binding, `${locale}: persona.binding must exist`);

  for (const [key, value] of Object.entries(binding)) {
    if (typeof value !== "string") {
      assert.fail(`${locale}: persona.binding.${key} must be a string`);
    }
    assert.ok(value.trim(), `${locale}: persona.binding.${key} must not be empty`);
  }

  return binding as Record<string, string>;
}

function loadSession(locale: (typeof locales)[number]): Record<string, string> {
  const file = new URL(`../locales/${locale}/profile.json`, import.meta.url);
  const profile = JSON.parse(readFileSync(file, "utf8")) as {
    persona?: { session?: Record<string, unknown> };
  };
  const session = profile.persona?.session;
  assert.ok(session, `${locale}: persona.session must exist`);
  for (const [key, value] of Object.entries(session)) {
    assert.equal(typeof value, "string", `${locale}: persona.session.${key} must be a string`);
    assert.ok((value as string).trim(), `${locale}: persona.session.${key} must not be empty`);
  }
  return session as Record<string, string>;
}

function interpolationVariables(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)]
    .map((match) => match[1]!)
    .sort();
}

test("persona binding translations are complete and interpolation-safe", () => {
  const reference = loadBinding("en");
  const referenceKeys = Object.keys(reference).sort();

  for (const locale of locales) {
    const binding = loadBinding(locale);
    assert.deepEqual(
      Object.keys(binding).sort(),
      referenceKeys,
      `${locale}: persona.binding keys must match English`,
    );

    for (const key of referenceKeys) {
      assert.deepEqual(
        interpolationVariables(binding[key]!),
        interpolationVariables(reference[key]!),
        `${locale}: persona.binding.${key} interpolation variables must match English`,
      );
    }
  }
});

test("persona session lock translations are complete and interpolation-safe", () => {
  const reference = loadSession("en");
  const referenceKeys = Object.keys(reference).sort();
  for (const locale of locales) {
    const session = loadSession(locale);
    assert.deepEqual(Object.keys(session).sort(), referenceKeys, `${locale}: persona.session keys must match English`);
    for (const key of referenceKeys) {
      assert.deepEqual(
        interpolationVariables(session[key]!),
        interpolationVariables(reference[key]!),
        `${locale}: persona.session.${key} interpolation variables must match English`,
      );
    }
  }
});

test("the shared persona menu only references translated keys", () => {
  const source = readFileSync(
    new URL("../features/chat/world-persona-menu.tsx", import.meta.url),
    "utf8",
  );
  const referencedKeys = [...source.matchAll(/t\("(persona\.[A-Za-z0-9.]+)"/g)]
    .map((match) => match[1]!)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .sort();

  for (const locale of locales) {
    const profile = JSON.parse(readFileSync(new URL(`../locales/${locale}/profile.json`, import.meta.url), "utf8"));
    for (const key of referencedKeys) {
      const value = key.split(".").reduce((node, part) => node?.[part], profile);
      assert.equal(typeof value, "string", `${locale}: missing ${key}`);
      assert.ok(value.trim(), `${locale}: empty ${key}`);
    }
    assert.deepEqual(interpolationVariables(profile.persona.session.current), ["name"]);
  }
});
