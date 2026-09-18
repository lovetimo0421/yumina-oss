import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The message SSE handlers are integration-heavy, so this source-level guard
// makes sure future route refactors keep the anti-repetition layers wired into
// send, regenerate, and continue together.
const src = readFileSync(
  fileURLToPath(new URL("./messages.ts", import.meta.url)),
  "utf8",
);

test("all generation paths pass repetitionPenalty to the provider", () => {
  for (const guard of [
    "antiRepetitionInstruction",
    "regenAntiRepetitionInstruction",
    "contAntiRepetitionInstruction",
  ]) {
    assert.match(
      src,
      new RegExp(`repetitionPenalty:\\s*${guard}\\s*\\?\\s*body\\.overrides\\?\\.repetitionPenalty\\s*:\\s*undefined`),
      guard,
    );
  }
});

test("all generation paths append the model-scoped recency instruction", () => {
  assert.equal(
    src.match(/antiRepetitionInstructionForModel\(model\)/g)?.length,
    3,
  );
});

test("all generation paths reject repetitive output before persistence", () => {
  assert.equal(src.match(/code:\s*"REPETITIVE_REPLY"/g)?.length, 3);

  const firstAssistantInsert = src.indexOf("const assistantMsgResult = await tx");
  const sendGuard = src.indexOf("? detectDegenerateRepetitionForModel(");
  assert.ok(sendGuard >= 0 && sendGuard < firstAssistantInsert);

  const swipePersistence = src.indexOf("const updatedSwipes = [...existingSwipes, newSwipe]");
  const regenerateGuard = src.indexOf(
    "? detectDegenerateRepetitionForModel(",
    sendGuard + 1,
  );
  assert.ok(regenerateGuard > sendGuard && regenerateGuard < swipePersistence);

  const continuationPersistence = src.indexOf("const finalContent = existingContent + cleanContinuation");
  const continueGuard = src.indexOf(
    "? detectDegenerateRepetitionForModel(",
    regenerateGuard + 1,
  );
  assert.ok(continueGuard > regenerateGuard && continueGuard < continuationPersistence);
});

test("all output gates receive the selected model for Kimi-only scoping", () => {
  assert.equal(
    src.match(/detectDegenerateRepetitionForModel\(\s*model,/g)?.length,
    3,
  );
  assert.doesNotMatch(src, /\bdetectDegenerateRepetition\(/);
});

test("Kimi-only prompt and output gates cannot leak into main's model fallbacks", () => {
  for (const guard of [
    "antiRepetitionInstruction",
    "regenAntiRepetitionInstruction",
    "contAntiRepetitionInstruction",
  ]) {
    // Argument list is matched loosely — the send path passes a third
    // (vision) argument across several lines. What must hold is the guard
    // itself: a Kimi turn gets no fallback chain at all.
    assert.match(
      src,
      new RegExp(
        `fallbackModels:\\s*${guard}\\s*\\?\\s*undefined\\s*:\\s*getOfficialProviderFallbackModels\\(\\s*model,\\s*resolved\\.isByok`,
      ),
      guard,
    );
  }
});

test("every generation path opts into transient fallback the same way", () => {
  // Free's chain may also descend on 429/5xx. All three paths must agree, or
  // one endpoint silently keeps failing turns the other two would have saved.
  assert.equal(
    src.match(/fallbackOnTransientErrors:\s*allowsTransientFallback\(model, resolved\.isByok\)/g)
      ?.length,
    3,
  );
});

test("main billing registry receives distinct no-charge repetition endpoints", () => {
  assert.equal(src.match(/endpoint:\s*"send_repetitive"/g)?.length, 1);
  assert.equal(src.match(/endpoint:\s*"regenerate_repetitive"/g)?.length, 1);
  assert.equal(src.match(/endpoint:\s*"continue_repetitive"/g)?.length, 1);
});
