import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { thinSnapshotForStorage, EPHEMERAL_METADATA_KEYS } from "./snapshot.js";

describe("thinSnapshotForStorage", () => {
  it("strips ephemeral macro fields but keeps real state metadata", () => {
    const snap = {
      worldId: "w1",
      turnCount: 7,
      ruleState: { fired: ["r1"] },
      variables: { hp: 9, lust: 3 },
      metadata: {
        // ephemeral — rebuilt every turn, must be dropped
        lastMessage: "a very long assistant reply ".repeat(50),
        lastCharMessage: "another long reply ".repeat(50),
        lastUserMessage: "the user said something",
        lastUserMessageAt: "2026-06-04T00:00:00Z",
        model: "anthropic/claude",
        // real state — must survive
        personaName: "Aria",
        personaImage: "s3://avatar.png",
        personaAppearance: "tall",
        activeAudio: [{ id: "bgm1", action: "play" }],
        pendingContext: [{ role: "system", content: "queued" }],
      },
    };

    const thin = thinSnapshotForStorage(snap);

    // variables / structural fields untouched
    assert.deepStrictEqual(thin.variables, { hp: 9, lust: 3 });
    assert.strictEqual(thin.turnCount, 7);
    assert.deepStrictEqual(thin.ruleState, { fired: ["r1"] });
    assert.strictEqual(thin.worldId, "w1");

    // ephemeral keys gone
    for (const k of EPHEMERAL_METADATA_KEYS) {
      assert.ok(!(k in thin.metadata), `expected ${k} to be stripped`);
    }

    // real state retained exactly
    assert.strictEqual(thin.metadata.personaName, "Aria");
    assert.strictEqual(thin.metadata.personaImage, "s3://avatar.png");
    assert.strictEqual(thin.metadata.personaAppearance, "tall");
    assert.deepStrictEqual(thin.metadata.activeAudio, [{ id: "bgm1", action: "play" }]);
    assert.deepStrictEqual(thin.metadata.pendingContext, [{ role: "system", content: "queued" }]);
  });

  it("does not mutate the input snapshot", () => {
    const snap = { variables: { hp: 1 }, metadata: { lastMessage: "x", personaName: "P" } };
    const thin = thinSnapshotForStorage(snap);
    assert.strictEqual((snap.metadata as Record<string, unknown>).lastMessage, "x"); // original intact
    assert.ok(!("lastMessage" in thin.metadata));
    assert.notStrictEqual(thin, snap);
    assert.notStrictEqual(thin.metadata, snap.metadata);
  });

  it("returns the same reference when there is nothing to strip", () => {
    const noMeta = { variables: { hp: 1 } };
    assert.strictEqual(thinSnapshotForStorage(noMeta), noMeta);

    const cleanMeta = { variables: {}, metadata: { personaName: "P", activeAudio: [] } };
    assert.strictEqual(thinSnapshotForStorage(cleanMeta), cleanMeta);
  });

  it("tolerates missing or non-object metadata", () => {
    assert.deepStrictEqual(thinSnapshotForStorage({ variables: {} }), { variables: {} });
    const weird = { variables: {}, metadata: null };
    assert.strictEqual(thinSnapshotForStorage(weird as unknown as Record<string, unknown>), weird);
  });
});
