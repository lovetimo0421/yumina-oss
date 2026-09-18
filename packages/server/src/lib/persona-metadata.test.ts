import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameStateManager } from "@yumina/engine";
import { applyPersonaMetadata } from "./persona-metadata.js";

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
    });
  });
});
