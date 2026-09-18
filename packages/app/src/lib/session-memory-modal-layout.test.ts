import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modalSource = readFileSync(
  join(here, "../../sandbox/extensions/session-memory/session-memory-modal.tsx"),
  "utf8",
);
const pickerSource = readFileSync(
  join(here, "../../sandbox/chat/model-picker-modal.tsx"),
  "utf8",
);
const worldRendererSource = readFileSync(
  join(here, "../features/chat/world-renderer.tsx"),
  "utf8",
);

test("all session context model pickers expose the server-backed BYOK provider switch", () => {
  assert.equal(
    modalSource.match(/allowExternalProviderSwitch/g)?.length,
    3,
    "memory, LocalDev, and Layered model pickers must all opt into provider switching",
  );
  assert.match(
    pickerSource,
    /const visibleProviderSwitch = !isExternalModelSelection \|\| allowExternalProviderSwitch/,
    "external model selection must expose the normal provider switch when opted in",
  );
  assert.match(
    pickerSource,
    /api\.setPreferredProvider\(confirmProvider\)/,
    "the switch must persist provider intent so server-side memory generation uses BYOK",
  );
});

test("session memory does not report regeneration success when no memory was produced", () => {
  assert.match(modalSource, /else if \(!data\.hasMemory\)/);
  assert.match(
    modalSource,
    /Session memory needs at least two assistant replies before it can be generated/,
  );
});

test("story-summary failures stay on the LocalDev tab instead of leaking into Session Memory", () => {
  assert.doesNotMatch(modalSource, /if \(memoryData\.error\) setError/);
  assert.doesNotMatch(modalSource, /else if \(summaryData\.error\) setError/);
  assert.match(modalSource, /error \|\| payload\?\.error/);
  assert.match(modalSource, /summaryPayload\?\.error && dismissedSummaryError !== summaryPayload\.error/);
});

test("a soft-capped story summary offers dismiss and one-shot resume controls", () => {
  assert.match(modalSource, /Resume automatic summaries/);
  assert.match(modalSource, /setDismissedSummaryError\(summaryPayload\.error\)/);
  assert.match(modalSource, /api\.resumeSessionSummaryAutoCompaction\(\)/);
  assert.match(worldRendererSource, /fetch\(`\$\{endpoint\}\/resume-auto`/);
  assert.match(modalSource, /Automatic Story Summary paused after 150 summary calls/);
  assert.doesNotMatch(modalSource, /300-call UTC daily safety ceiling/);
});
