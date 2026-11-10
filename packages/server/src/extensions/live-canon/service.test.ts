import "../../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { GameStateManager, type Variable, type WorldDefinition, type WorldEntry } from "@yumina/engine";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playSessions, user, worlds } from "../../db/schema.js";
import {
  LiveCanonError,
  applyLiveCanonStateUpdates,
  canEditLiveCanonEntry,
  canEditLiveCanonVariable,
  isSafeLiveCanonContent,
  loadLiveCanonContext,
  type LiveCanonContext,
} from "./service.js";

function variable(overrides: Partial<Variable> = {}): Variable {
  return {
    id: "age",
    name: "Age",
    type: "number",
    defaultValue: 18,
    liveCanonEditable: false,
    ...overrides,
  } as Variable;
}

function entry(overrides: Partial<WorldEntry> = {}): WorldEntry {
  return {
    id: "history",
    name: "History",
    content: "Author canon",
    role: "lore",
    alwaysSend: true,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    position: 1,
    section: "system-presets",
    sessionEditPolicy: "content",
    ...overrides,
  };
}

function world(variables: Variable[]): WorldDefinition {
  return {
    id: "world",
    name: "World",
    description: "",
    author: "",
    version: "21.0.0",
    settings: {},
    variables,
    rules: [],
    reactions: [],
    components: [],
    customUI: [],
    audioTracks: [],
    entries: [],
  };
}

test("players can edit only explicitly permitted primitive, non-internal variables", () => {
  assert.equal(canEditLiveCanonVariable(variable(), false), false);
  assert.equal(canEditLiveCanonVariable(variable({ liveCanonEditable: true }), false), true);
  assert.equal(canEditLiveCanonVariable(variable({ liveCanonEditable: true, internal: true }), false), false);
  assert.equal(canEditLiveCanonVariable(variable({ type: "json", defaultValue: {} } as Partial<Variable>), false), false);
  assert.equal(canEditLiveCanonVariable(variable(), true), true);
});

test("only author-approved lore roles can be overridden", () => {
  assert.equal(canEditLiveCanonEntry(entry()), true);
  assert.equal(canEditLiveCanonEntry(entry({ sessionEditPolicy: "locked" })), false);
  assert.equal(canEditLiveCanonEntry(entry({ role: "greeting" })), false);
  assert.equal(canEditLiveCanonEntry(entry({ role: "example" })), false);
  assert.equal(canEditLiveCanonEntry(entry({ role: "system" })), false);
  assert.equal(canEditLiveCanonEntry(entry({ role: "plot" })), true);
  assert.equal(canEditLiveCanonEntry(entry({ role: "custom" })), true);
});

test("session lore remains plain text and rejects executable prompt syntax", () => {
  assert.equal(isSafeLiveCanonContent("Mira is now 25 years old."), true);
  assert.equal(isSafeLiveCanonContent("Age: {{age}}"), false);
  assert.equal(isSafeLiveCanonContent("[var: set age 25]"), false);
  assert.equal(isSafeLiveCanonContent("<yumina-state>hidden</yumina-state>"), false);
});

test("state updates use the engine and reject unapproved or mistyped writes", () => {
  const definition = world([
    variable({ liveCanonEditable: true }),
    variable({ id: "secret", name: "Secret", defaultValue: 3 }),
  ]);
  const ctx: LiveCanonContext = {
    sessionId: "session",
    userId: "player",
    worldId: "world",
    worldCreatorId: "author",
    allowAdditions: false,
    state: new GameStateManager(definition).getSnapshot() as unknown as Record<string, unknown>,
    worldDef: definition,
  };

  const updated = applyLiveCanonStateUpdates(ctx, ctx.state, { age: 25 });
  assert.equal(updated.variables.age, 25);
  assert.throws(
    () => applyLiveCanonStateUpdates(ctx, ctx.state, { secret: 4 }),
    (error) => error instanceof LiveCanonError && error.code === "LIVE_CANON_FORBIDDEN",
  );
  assert.throws(
    () => applyLiveCanonStateUpdates(ctx, ctx.state, { age: "twenty" }),
    (error) => error instanceof LiveCanonError && error.status === 400,
  );
});

test("a disabled author gate wins before install and schema checks and exposes no data", async (t) => {
  const userId = `live-canon-${randomUUID()}`;
  const [createdUser] = await db.insert(user).values({
    id: userId,
    name: "Lore Shift player",
    email: `${userId}@test.local`,
    emailVerified: true,
  }).returning();
  const [createdWorld] = await db.insert(worlds).values({
    creatorId: createdUser!.id,
    name: "Locked story",
    allowLiveCanon: false,
    schema: { deliberatelyInvalid: true },
  }).returning();
  const [createdSession] = await db.insert(playSessions).values({
    userId: createdUser!.id,
    worldId: createdWorld!.id,
    state: { privateStateThatMustNotBeReturned: "secret" },
  }).returning();
  t.after(async () => {
    await db.delete(user).where(eq(user.id, userId));
  });

  await assert.rejects(
    loadLiveCanonContext(createdSession!.id, createdUser!.id),
    (error) => (
      error instanceof LiveCanonError
      && error.code === "AUTHOR_DISABLED_LIVE_CANON"
      && !error.message.includes("secret")
    ),
  );
});
