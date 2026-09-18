import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/index.js";
import { worlds, worldPendingEdits, user } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { resolveSessionVariables } from "./pending-edit.js";
import { preserveSetupScopedVariables } from "@yumina/engine";
import type { Variable } from "@yumina/engine";

// Root-cause regression for the K-pop "选X只出X" bug on PUBLISHED cards:
// the opening-switch (switchGreeting → swipe) adoption path resolved the
// setup-scoped variable definitions from the LIVE worlds.schema instead of the
// working copy the creator actually plays. A cast-selection variable
// (selected-members, scope:"setup") that lives only in the held draft was
// therefore invisible, so preserveSetupScopedVariables() had nothing to carry
// forward and the player's pick was wiped back to the snapshot default ([]) →
// the gate entry read empty → every member appeared. It worked for UNPUBLISHED
// cards (live schema == working copy) and for published cards whose edit had
// already been committed to live — but not for held-in-draft fixes.

describe("resolveSessionVariables (working-copy-aware setup-scope resolution)", () => {
  let creatorId: string;
  let otherId: string;
  let worldId: string;

  const liveVars: Variable[] = [
    { id: "hp", name: "HP", type: "number", defaultValue: 10 },
  ];
  // The held draft ADDS the setup-scoped cast variable that the live schema lacks.
  const draftVars: Variable[] = [
    { id: "hp", name: "HP", type: "number", defaultValue: 10 },
    { id: "selected-members", name: "Cast", type: "json", defaultValue: "[]", scope: "setup" },
  ];

  beforeEach(async () => {
    const [c] = await db.insert(user).values({
      id: `test-user-${crypto.randomUUID()}`,
      name: "Creator",
      email: `${crypto.randomUUID()}@test.local`,
      emailVerified: true,
    }).returning();
    creatorId = c!.id;
    const [o] = await db.insert(user).values({
      id: `test-user-${crypto.randomUUID()}`,
      name: "Player",
      email: `${crypto.randomUUID()}@test.local`,
      emailVerified: true,
    }).returning();
    otherId = o!.id;

    const [w] = await db.insert(worlds).values({
      creatorId,
      name: "Roster Card",
      status: "published",
      schema: { name: "Roster Card", entries: [], variables: liveVars },
    }).returning();
    worldId = w!.id;

    await db.insert(worldPendingEdits).values({
      worldId,
      createdBy: creatorId,
      groupKey: worldId,
      status: "draft",
      schema: { name: "Roster Card", entries: [], variables: draftVars },
    });
  });

  afterEach(async () => {
    await db.delete(user).where(eq(user.id, creatorId));
    await db.delete(user).where(eq(user.id, otherId));
  });

  it("returns the HELD DRAFT variables for the creator playing their own published card", async () => {
    const vars = (await resolveSessionVariables(worldId, creatorId)) as Variable[];
    const setup = vars.find((v) => v.id === "selected-members");
    assert.ok(setup, "creator must see the draft-only setup variable");
    assert.strictEqual(setup!.scope, "setup");
  });

  it("returns the LIVE variables for a regular player (no working-copy leak)", async () => {
    const vars = (await resolveSessionVariables(worldId, otherId)) as Variable[];
    assert.strictEqual(vars.find((v) => v.id === "selected-members"), undefined);
    assert.ok(vars.find((v) => v.id === "hp"));
  });

  it("end-to-end: the creator's cast pick survives an opening switch (the bug)", async () => {
    // Simulate the swipe adoption: the player picked a cast, then switched
    // opening (snapshot = world defaults with selected-members back to []).
    const current = { variables: { "selected-members": ["Yujin", "Wonyoung"], hp: 5 } };
    const openingSnapshot = { variables: { "selected-members": [], hp: 10 } };

    // BEFORE (bug): live vars → no setup id → pick wiped.
    const liveResolved = (await resolveSessionVariables(worldId, otherId)) as Variable[];
    const wiped = preserveSetupScopedVariables(liveResolved, current, structuredClone(openingSnapshot));
    assert.deepStrictEqual(wiped.variables["selected-members"], [], "live-var path cannot preserve a draft-only setup var");

    // AFTER (fix): working-copy vars → setup id known → pick preserved.
    const wcResolved = (await resolveSessionVariables(worldId, creatorId)) as Variable[];
    const kept = preserveSetupScopedVariables(wcResolved, current, structuredClone(openingSnapshot));
    assert.deepStrictEqual(kept.variables["selected-members"], ["Yujin", "Wonyoung"]);
  });

  it("falls back to live variables when the published card has no held edit", async () => {
    await db.delete(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId));
    const vars = (await resolveSessionVariables(worldId, creatorId)) as Variable[];
    assert.strictEqual(vars.find((v) => v.id === "selected-members"), undefined);
  });
});
