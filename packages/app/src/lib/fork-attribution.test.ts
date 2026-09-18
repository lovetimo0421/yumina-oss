import assert from "node:assert/strict";
import test from "node:test";
import { isOwnTranslationSource } from "./fork-attribution";

const GROUP = "47fd11f3-5244-4613-a259-b53d59c76ca0";

// The Unrivaled Tang Sect (en) → 绝世唐门 (zh), both by mia~, one group.
test("suppresses attribution for a creator's own translation of their own card", () => {
  assert.equal(
    isOwnTranslationSource(
      { creatorId: "mia", languageGroupId: GROUP },
      { creatorId: "mia", languageGroupId: GROUP },
    ),
    true,
  );
});

// Abandoned Academy (en, re) → 废弃学院 (zh, kljws), linked into one group.
test("keeps attribution when the source belongs to another creator", () => {
  assert.equal(
    isOwnTranslationSource(
      { creatorId: "re", languageGroupId: GROUP },
      { creatorId: "kljws", languageGroupId: GROUP },
    ),
    false,
  );
});

test("keeps attribution for a plain fork — no language group on either side", () => {
  assert.equal(
    isOwnTranslationSource(
      { creatorId: "mia", languageGroupId: null },
      { creatorId: "mia", languageGroupId: null },
    ),
    false,
  );
});

test("keeps attribution when only one side is grouped", () => {
  assert.equal(
    isOwnTranslationSource(
      { creatorId: "mia", languageGroupId: GROUP },
      { creatorId: "mia", languageGroupId: null },
    ),
    false,
  );
  assert.equal(
    isOwnTranslationSource(
      { creatorId: "mia", languageGroupId: null },
      { creatorId: "mia", languageGroupId: GROUP },
    ),
    false,
  );
});

test("keeps attribution across different language groups", () => {
  assert.equal(
    isOwnTranslationSource(
      { creatorId: "mia", languageGroupId: GROUP },
      { creatorId: "mia", languageGroupId: "other-group" },
    ),
    false,
  );
});

test("handles a missing source row", () => {
  assert.equal(isOwnTranslationSource({ creatorId: "mia", languageGroupId: GROUP }, null), false);
  assert.equal(isOwnTranslationSource({ creatorId: "mia", languageGroupId: GROUP }, undefined), false);
});

test("does not treat two null creators as a match", () => {
  assert.equal(
    isOwnTranslationSource(
      { creatorId: null, languageGroupId: GROUP },
      { creatorId: null, languageGroupId: GROUP },
    ),
    false,
  );
});
