import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { user, worlds, worldPendingEdits } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition } from "@yumina/engine";
import { mergeGameStatePatch } from "../lib/game-state.js";
import { resolveSessionWorldSchema } from "../lib/pending-edit.js";

// Regression for the K-pop "选X只出X" selection NOT persisting for the creator.
// PATCH /api/sessions/:id/state normalizes the patched state against a worldDef.
// normalizeState() drops any variable not declared in that worldDef. When the
// handler used the LIVE schema, a setup variable that exists only in the held
// working copy (e.g. selected-members, added by a not-yet-approved edit) was
// stripped on every setVariable — the creator's cast pick reset to default.
// The fix: resolve the worldDef from the creator's working copy.

describe("state-patch resolves the creator's working copy (selection persists)", () => {
  let creatorId: string;
  let playerId: string;
  let worldId: string;

  // live published schema lacks the selection variable; the held edit adds it.
  const liveSchema = {
    id: "w", name: "Roster", entries: [],
    variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 10 }],
  };
  const workingCopy = {
    id: "w", name: "Roster", entries: [],
    variables: [
      { id: "hp", name: "HP", type: "number", defaultValue: 10 },
      { id: "selected-members", name: "Cast", type: "json", defaultValue: "[]", scope: "setup" },
    ],
  };

  beforeEach(async () => {
    const [c] = await db.insert(user).values({ id: `t-${randomUUID()}`, name: "Creator", email: `${randomUUID()}@t.local`, emailVerified: true }).returning();
    creatorId = c!.id;
    const [p] = await db.insert(user).values({ id: `t-${randomUUID()}`, name: "Player", email: `${randomUUID()}@t.local`, emailVerified: true }).returning();
    playerId = p!.id;
    const [w] = await db.insert(worlds).values({ creatorId, name: "Roster", status: "published", schema: liveSchema }).returning();
    worldId = w!.id;
    await db.insert(worldPendingEdits).values({ worldId, createdBy: creatorId, groupKey: worldId, status: "draft", schema: workingCopy });
  });

  afterEach(async () => {
    await db.delete(user).where(eq(user.id, creatorId));
    await db.delete(user).where(eq(user.id, playerId));
  });

  // Exercises the REAL shipped helper used by every session play path
  // (state-patch, execute-action, revert, restart, branch, checkpoint-restore).
  async function resolvePatchSchema(viewerId: string) {
    const [live] = await db.select().from(worlds).where(eq(worlds.id, worldId));
    const schema = await resolveSessionWorldSchema(live!, viewerId);
    return migrateWorldDefinition(schema as never);
  }

  it("keeps the creator's setVariable on a working-copy-only setup variable", async () => {
    const worldDef = await resolvePatchSchema(creatorId);
    const merged = mergeGameStatePatch(worldDef, { variables: { hp: 10 } }, { variables: { "selected-members": ["Yujin", "Wonyoung"] } });
    assert.deepStrictEqual(merged.variables["selected-members"], ["Yujin", "Wonyoung"]);
  });

  it("(documents the bug) the LIVE schema would strip it — proving the worldDef choice matters", async () => {
    const liveDef = migrateWorldDefinition(liveSchema as never);
    const merged = mergeGameStatePatch(liveDef, { variables: { hp: 10 } }, { variables: { "selected-members": ["Yujin", "Wonyoung"] } });
    assert.strictEqual(merged.variables["selected-members"], undefined);
  });

  it("a regular player keeps using the live schema (no working-copy leak)", async () => {
    const worldDef = await resolvePatchSchema(playerId);
    const merged = mergeGameStatePatch(worldDef, { variables: { hp: 10 } }, { variables: { "selected-members": ["Yujin"] } });
    // player's worldDef has no selected-members → not persisted (live behavior, unchanged)
    assert.strictEqual(merged.variables["selected-members"], undefined);
  });
});
