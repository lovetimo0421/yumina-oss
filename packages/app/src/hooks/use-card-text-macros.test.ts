import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCardTextMacros } from "./use-card-text-macros";

test("card descriptions resolve {{user}} to the viewer and {{char}} to the card", () => {
  assert.equal(
    resolveCardTextMacros("{{user}} meets {{char}}. {{User}} waves at {{CHAR}}.", "你", "芙莉莲"),
    "你 meets 芙莉莲. 你 waves at 芙莉莲.",
  );
});

test("text without macros is returned untouched", () => {
  const text = "No macros {here}";
  assert.equal(resolveCardTextMacros(text, "you", "Card"), text);
});
