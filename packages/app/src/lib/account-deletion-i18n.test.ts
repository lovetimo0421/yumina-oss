import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const locales = ["en", "zh", "zh-Hant", "ja", "es"] as const;

function loadDeleteAccount(locale: string): Record<string, unknown> {
  const file = new URL(`../locales/${locale}/settings.json`, import.meta.url);
  const settings = JSON.parse(readFileSync(file, "utf8")) as {
    account?: { deleteAccount?: Record<string, unknown> };
  };
  assert.ok(settings.account?.deleteAccount, `${locale}: missing account.deleteAccount`);
  return settings.account.deleteAccount;
}

function flatten(
  value: Record<string, unknown>,
  prefix = "",
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") {
      result.set(path, child);
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      for (const [nestedKey, nestedValue] of flatten(child as Record<string, unknown>, path)) {
        result.set(nestedKey, nestedValue);
      }
    } else {
      assert.fail(`${path}: account deletion translations must be strings or objects`);
    }
  }
  return result;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{([^}]+)\}\}/g)]
    .map((match) => match[1]!)
    .sort();
}

test("account deletion translations are complete and interpolation-safe", () => {
  const english = flatten(loadDeleteAccount("en"));
  assert.equal(english.has("errors.adminOnly"), false);

  for (const locale of locales) {
    const translated = flatten(loadDeleteAccount(locale));
    assert.deepEqual(
      [...translated.keys()].sort(),
      [...english.keys()].sort(),
      `${locale}: account deletion translation keys`,
    );
    for (const [key, englishValue] of english) {
      const translatedValue = translated.get(key);
      assert.ok(translatedValue?.trim(), `${locale}: ${key} must not be empty`);
      assert.deepEqual(
        placeholders(translatedValue!),
        placeholders(englishValue),
        `${locale}: ${key} interpolation placeholders`,
      );
    }
  }
});

test("post-deletion repeat-deletion cooldown is localized everywhere it is shown", () => {
  for (const locale of locales) {
    const deletion = flatten(loadDeleteAccount(locale));
    for (const key of [
      "dialogDescription",
      "warnings.deletionCooldown",
      "acknowledge",
      "emailSentDescription",
      "finalConfirmationDescription",
      "errors.cooldown",
    ]) {
      assert.ok(deletion.get(key)?.includes("3"), `${locale}: ${key} cooldown notice`);
    }

    const file = new URL(`../locales/${locale}/auth.json`, import.meta.url);
    const auth = JSON.parse(readFileSync(file, "utf8")) as {
      login?: { accountDeleted?: string };
      errors?: { reRegistrationCooldown?: string };
    };
    assert.ok(auth.login?.accountDeleted?.includes("3"), `${locale}: deleted-account notice`);
    assert.equal(auth.errors?.reRegistrationCooldown, undefined, `${locale}: obsolete signup block`);
  }
});
