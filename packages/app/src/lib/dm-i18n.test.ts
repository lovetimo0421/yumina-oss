import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const locales = ["en", "zh", "zh-Hant", "ja", "es"] as const;
const requiredKeys = [
  "block",
  "editing",
  "jump",
  "messageActions",
  "messageRecalled",
  "noMatchingMessages",
  "replyingTo",
  "searchMessages",
  "unblock",
] as const;

for (const locale of locales) {
  test(`${locale} contains every DM interaction translation`, () => {
    const file = new URL(`../locales/${locale}/common.json`, import.meta.url);
    const common = JSON.parse(readFileSync(file, "utf8")) as {
      dm?: Record<string, string>;
    };

    for (const key of requiredKeys) {
      assert.ok(common.dm?.[key]?.trim(), `${locale}: missing dm.${key}`);
    }
    assert.match(common.dm?.messageRecalled ?? "", /\{\{name\}\}/, `${locale}: dm.messageRecalled must preserve {{name}}`);
  });
}
