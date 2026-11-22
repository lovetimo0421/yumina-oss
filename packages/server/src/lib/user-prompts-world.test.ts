import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { promptFolders, user, userPrompts, userWorldPrompts, worlds } from "../db/schema.js";
import { loadUserPrompts, loadWorldPromptSwitches, selectUserPrompts } from "./user-prompts.js";

// Per-world prompt switches (2026-11-04): a player asked for writing-style
// prompts to stay on in one world and off in another without flipping them
// by hand every time they changed worlds.

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const userId = `world-prompts-${randomUUID()}`;
  await db.insert(user).values({ id: userId, name: "World prompts player", email: `${userId}@test.local`, emailVerified: true });
  t.after(async () => { await db.delete(user).where(eq(user.id, userId)); });
  const [a] = await db.insert(worlds).values({ creatorId: userId, name: "Wuxia", schema: {} }).returning();
  const [b] = await db.insert(worlds).values({ creatorId: userId, name: "Noir", schema: {} }).returning();
  const [style] = await db.insert(userPrompts).values({ userId, name: "Wuxia style", content: "Write like a wuxia novel.", enabled: false }).returning();
  const [always] = await db.insert(userPrompts).values({ userId, name: "No speaking for me", content: "Never speak for the player.", enabled: true }).returning();
  return { userId, a: a!, b: b!, style: style!, always: always! };
}

const names = (rows: { name: string }[]) => rows.map(r => r.name).sort();

test("a switch set in one world applies there only; other worlds follow the prompt's own switch", async (t) => {
  const f = await fixture(t);
  await db.insert(userWorldPrompts).values([
    { userId: f.userId, worldId: f.a.id, promptId: f.style.id, enabled: true },
    { userId: f.userId, worldId: f.a.id, promptId: f.always.id, enabled: false },
  ]);

  assert.deepEqual(names(await loadUserPrompts(f.userId, { worldId: f.a.id })), ["Wuxia style"]);
  assert.deepEqual(names(await loadUserPrompts(f.userId, { worldId: f.b.id })), ["No speaking for me"]);
  assert.deepEqual(names(await loadUserPrompts(f.userId)), ["No speaking for me"], "no world = account-wide switches");
  assert.deepEqual(Object.fromEntries(await loadWorldPromptSwitches(f.userId, f.a.id)), { [f.style.id]: true, [f.always.id]: false });
});

test("a disabled folder still wins over a world switch, and the per-model binding still applies", async (t) => {
  const f = await fixture(t);
  const [folder] = await db.insert(promptFolders).values({ userId: f.userId, name: "Pack", enabled: false }).returning();
  await db.update(userPrompts).set({ folderId: folder!.id }).where(eq(userPrompts.id, f.style.id));
  await db.insert(userWorldPrompts).values({ userId: f.userId, worldId: f.a.id, promptId: f.style.id, enabled: true });
  assert.deepEqual(names(await loadUserPrompts(f.userId, { worldId: f.a.id })), ["No speaking for me"]);

  await db.update(promptFolders).set({ enabled: true }).where(eq(promptFolders.id, folder!.id));
  await db.update(userPrompts).set({ autoModels: ["claude"] }).where(eq(userPrompts.id, f.style.id));
  assert.deepEqual(names(await loadUserPrompts(f.userId, { worldId: f.a.id, modelId: "google/gemini-3-flash" })), ["No speaking for me"]);
  assert.deepEqual(names(await loadUserPrompts(f.userId, { worldId: f.a.id, modelId: "anthropic/claude-sonnet-5" })), ["No speaking for me", "Wuxia style"]);
});

test("deleting the prompt or the world takes its world switches with it", async (t) => {
  const f = await fixture(t);
  await db.insert(userWorldPrompts).values([
    { userId: f.userId, worldId: f.a.id, promptId: f.style.id, enabled: true },
    { userId: f.userId, worldId: f.b.id, promptId: f.always.id, enabled: false },
  ]);
  await db.delete(userPrompts).where(eq(userPrompts.id, f.style.id));
  await db.delete(worlds).where(eq(worlds.id, f.b.id));
  const left = await db.select().from(userWorldPrompts).where(eq(userWorldPrompts.userId, f.userId));
  assert.equal(left.length, 0);
});

test("pure selection: the world switch replaces the prompt's own switch", () => {
  const row = (id: string, enabled: boolean) => ({ id, name: id, content: id, section: "system-presets" as const, enabled, depth: null, position: null, folderId: null, kind: null, apiRole: null, autoModels: null });
  const picked = selectUserPrompts([row("off", false), row("on", true)], [], true, {}, new Map([["off", true], ["on", false]]));
  assert.deepEqual(picked.map(p => p.id), ["off"]);
});
