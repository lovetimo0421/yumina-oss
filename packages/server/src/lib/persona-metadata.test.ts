import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameStateManager } from "@yumina/engine";
import { applyPersonaMetadata, omitPersonaMetadata, omitSummaryMetadata } from "./persona-metadata.js";

function metadataRecorder(initial: Record<string, unknown> = {}) {
  const metadata = { ...initial };
  const stateManager = {
    setMetadata(key: string, value: unknown) {
      metadata[key] = value;
    },
  } as unknown as GameStateManager;
  return { metadata, stateManager };
}

describe("applyPersonaMetadata", () => {
  it("marks an active persona and writes all prompt-facing fields", () => {
    const { metadata, stateManager } = metadataRecorder();

    applyPersonaMetadata(
      stateManager,
      {
        name: "Alex",
        avatarUrl: "alex.png",
        appearance: "silver hair",
        personality: "reserved",
        backstory: "from the old city",
      },
      { username: "account-name" },
    );

    assert.equal(metadata.personaActive, true);
    assert.equal(metadata.personaName, "Alex");
    assert.equal(metadata.personaAppearance, "silver hair");
    assert.equal(metadata.personaPersonality, "reserved");
    assert.equal(metadata.personaBackstory, "from the old city");
  });

  it("clears stale persona details while preserving the account identity for {{user}}", () => {
    const { metadata, stateManager } = metadataRecorder({
      personaActive: true,
      personaName: "Old Persona",
      personaAppearance: "stale appearance",
      personaPersonality: "stale personality",
      personaBackstory: "stale backstory",
    });

    applyPersonaMetadata(stateManager, null, {
      username: "account-name",
      image: "account.png",
    });

    assert.deepEqual(metadata, {
      personaActive: false,
      personaName: "account-name",
      personaImage: "account.png",
      personaAppearance: "",
      personaPersonality: "",
      personaBackstory: "",
      personaEntries: [],
    });
  });
});

describe("omitPersonaMetadata", () => {
  it("removes every identity field written by the persona overlay and preserves gameplay", () => {
    const { metadata, stateManager } = metadataRecorder({ weather: "rain", personaQuest: "a gameplay value" });
    applyPersonaMetadata(stateManager, { name: "Ari", backstory: "Unplayed lore", entries: [{ title: "Family", content: "Unplayed family" }] }, {});
    const state = { metadata, variables: { personaName: "a creator variable", coins: 3 }, turnCount: 2 };
    const before = structuredClone(state);
    Object.freeze(metadata);
    Object.freeze(state);
    assert.deepEqual(omitPersonaMetadata(state), {
      metadata: { weather: "rain", personaQuest: "a gameplay value" },
      variables: state.variables, turnCount: 2,
    });
    assert.deepEqual(state, before);
  });

  it("also excludes account identity when the persona is disabled", () => {
    const { metadata, stateManager } = metadataRecorder();
    applyPersonaMetadata(stateManager, null, { username: "private-handle", image: "private-image" });
    assert.deepEqual(omitPersonaMetadata({ metadata }), { metadata: {} });
  });

  it("tolerates absent or malformed legacy states without inventing gameplay", () => {
    for (const state of [null, undefined, 7, "legacy", [], {}, { metadata: null }, { metadata: [] }, { metadata: "legacy" }]) {
      assert.deepEqual(omitPersonaMetadata(state), state);
    }
  });
});

describe("omitSummaryMetadata", () => {
  it("removes legacy transcript mirrors without deleting creator variables or rewriting snapshots", () => {
    const mirrors = { lastMessage: "old assistant", lastCharMessage: "old character", lastUserMessage: "old user",
      lastUserMessageAt: "old timestamp", model: "old model" };
    const state = { metadata: { ...mirrors, personaBackstory: "old persona", weather: "rain" },
      variables: { ...mirrors, personaBackstory: "creator-authored gameplay value" }, turnCount: 9 };
    const original = structuredClone(state);
    Object.freeze(state.metadata);
    Object.freeze(state);
    assert.deepEqual(omitSummaryMetadata(state), { metadata: { weather: "rain" }, variables: state.variables, turnCount: 9 });
    assert.deepEqual(state, original, "rewind snapshots remain unchanged");
  });

  it("preserves absent and malformed legacy state shapes", () => {
    for (const state of [null, undefined, 7, "legacy", [], {}, { metadata: null }, { metadata: [] }, { metadata: "legacy" }]) {
      assert.deepEqual(omitSummaryMetadata(state), state);
    }
  });
});
