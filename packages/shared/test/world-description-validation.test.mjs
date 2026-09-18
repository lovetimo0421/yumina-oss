import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorldSchema,
  MAX_WORLD_DESCRIPTION,
  updateWorldSchema,
} from "../dist/index.js";

describe("world description validation", () => {
  it("accepts the full description length advertised by Studio", () => {
    const description = "x".repeat(MAX_WORLD_DESCRIPTION);

    assert.equal(
      createWorldSchema.safeParse({ name: "Test world", description }).success,
      true,
    );
    assert.equal(updateWorldSchema.safeParse({ description }).success, true);
  });

  it("rejects descriptions longer than the advertised limit", () => {
    const description = "x".repeat(MAX_WORLD_DESCRIPTION + 1);

    assert.equal(
      createWorldSchema.safeParse({ name: "Test world", description }).success,
      false,
    );
    assert.equal(updateWorldSchema.safeParse({ description }).success, false);
  });
});
