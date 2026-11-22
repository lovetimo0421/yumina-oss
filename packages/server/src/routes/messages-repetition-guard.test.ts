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

const GATE = "const repetition = detectDegenerateRepetitionForModel(";

function gatePositions(): number[] {
  const positions: number[] = [];
  for (let at = src.indexOf(GATE); at >= 0; at = src.indexOf(GATE, at + 1)) positions.push(at);
  return positions;
}

test("all generation paths run the repetition gate for every model", () => {
  // The gate used to sit behind `antiRepetitionInstruction ? … : null`, which
  // only Kimi sets — GLM's "Our Our Our …" replies went through and were billed.
  assert.equal(gatePositions().length, 3);
  assert.doesNotMatch(src, /const repetition = \w*[aA]ntiRepetitionInstruction\s*\?/);
});

test("all generation paths reject repetitive output before persistence and before any charge", () => {
  assert.equal(src.match(/code:\s*"REPETITIVE_REPLY"/g)?.length, 3);
  const [sendGuard, regenerateGuard, continueGuard] = gatePositions() as [number, number, number];

  const firstAssistantInsert = src.indexOf("const assistantMsgResult = await tx");
  assert.ok(sendGuard >= 0 && sendGuard < firstAssistantInsert);

  const swipePersistence = src.indexOf("const updatedSwipes = [...existingSwipes, newSwipe]");
  assert.ok(regenerateGuard > sendGuard && regenerateGuard < swipePersistence);

  const continuationPersistence = src.indexOf("const finalContent = existingContent + cleanContinuation");
  assert.ok(continueGuard > regenerateGuard && continueGuard < continuationPersistence);

  // Each path's story charge (prepareStoryCharge, then the wallet debit) comes
  // after its gate, and the gate returns — a looped reply is never billed.
  for (const [gate, next] of [[sendGuard, regenerateGuard], [regenerateGuard, continueGuard], [continueGuard, src.length]] as const) {
    const charge = src.indexOf("await outputAttempt.prepareStoryCharge(", gate);
    // The send path debits through chargeRoomReply (a split story room shares the cost).
    const debit = Math.min(...["await deductCreditsUpToBalance(", "await chargeRoomReply("]
      .map((call) => src.indexOf(call, gate)).filter((at) => at >= 0));
    assert.ok(charge > gate && charge < next, "story charge follows the gate");
    assert.ok(debit > charge && debit < next, "wallet debit follows the gate");
    const rejection = src.slice(gate, charge);
    assert.match(rejection, /_repetitive"/);
    assert.match(rejection, /return;/);
  }
});

test("all output gates receive the selected model (previous-reply check is Kimi-only)", () => {
  assert.equal(
    src.match(/detectDegenerateRepetitionForModel\(\s*model,/g)?.length,
    3,
  );
  assert.doesNotMatch(src, /\bdetectDegenerateRepetition\(/);
});

test("the Kimi-only prompt instruction cannot leak into main's model fallbacks", () => {
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
