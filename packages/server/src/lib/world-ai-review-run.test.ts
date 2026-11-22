// The AI first look reads both sides of a held update: the live card (what
// was approved) and the held edit. Uses the isolated in-memory schema.

import "../test/database-fixture.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { runWorldAiReview } from "./world-ai-review-run.js";
import { chooseReviewScope, type ReviewSide } from "./world-ai-review-diff.js";
import type { WorldAiReview } from "./world-ai-review-core.js";

const ui = Array.from({ length: 40 }, (_, i) => `<div>Row ${i}</div>`).join("\n");
const liveSchema = { entries: [{ id: "e1", name: "Lore", content: "An old academy." }], rootComponent: { entryFile: "index.tsx", files: { "index.tsx": ui } } };
const heldSchema = { ...liveSchema, rootComponent: { entryFile: "index.tsx", files: { "index.tsx": `${ui}\n<div>New turn counter</div>` } } };

type Seen = ReviewSide & { live: ReviewSide | null; approved: boolean };

async function seed(opts: { approvedBefore: boolean }) {
  const creatorId = `test-diff-${crypto.randomUUID()}`;
  const worldId = crypto.randomUUID();
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified) VALUES (${creatorId}, 'Diff', ${`${crypto.randomUUID()}@test.local`}, true)`);
  await db.execute(sql`
    INSERT INTO worlds (id, creator_id, name, description, language, is_published, status, visibility, age_rating, thumbnail_url, schema)
    VALUES (${worldId}, ${creatorId}, 'Academy', 'A school story.', 'en', true, 'published', 'public', 'sensitive', 'users/x/cover.png', ${JSON.stringify(liveSchema)}::jsonb)`);
  if (opts.approvedBefore) {
    await db.execute(sql`
      INSERT INTO world_review_submissions (id, world_id, group_key, submitted_by, decision, submission_type, submitted_at, decided_at)
      VALUES (${crypto.randomUUID()}, ${worldId}, ${worldId}, ${creatorId}, 'approved', 'initial', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')`);
  }
  await db.execute(sql`
    INSERT INTO world_pending_edits (id, world_id, created_by, group_key, schema, reasons, status, thumbnail_url, age_rating, metadata)
    VALUES (${crypto.randomUUID()}, ${worldId}, ${creatorId}, ${worldId}, ${JSON.stringify(heldSchema)}::jsonb, '["frontend"]'::jsonb, 'pending', 'users/x/cover.png', 'sensitive',
      ${JSON.stringify({ name: "Academy", description: "A school story." })}::jsonb)`);
  await db.execute(sql`
    INSERT INTO world_review_submissions (id, world_id, group_key, submitted_by, decision, submission_type)
    VALUES (${crypto.randomUUID()}, ${worldId}, ${worldId}, ${creatorId}, 'pending', 'edit')`);
  return worldId;
}

async function look(worldId: string): Promise<{ seen: Seen; stored: WorldAiReview }> {
  let seen: Seen | null = null;
  const result = await runWorldAiReview(worldId, {
    notesOnly: true,
    review: async (e) => {
      seen = e as unknown as Seen;
      return { outcome: "approved", reasons: [], suggested: { contentMode: "limitless", audience: null, coverBlur: true }, author: { contentMode: "limitless", audience: "male", coverBlur: true }, models: [], at: "" };
    },
  });
  assert.equal(result, "noted");
  const rows = (await db.execute(sql`SELECT ai_review FROM world_review_submissions WHERE world_id = ${worldId} AND decision = 'pending'`)) as unknown as { rows: Array<{ ai_review: WorldAiReview }> };
  return { seen: seen!, stored: rows.rows[0]!.ai_review };
}

describe("world AI review reads the live card beside a held update", () => {
  before(() => { process.env.WORLD_AI_REVIEW = "1"; });

  it("an approved live card with a held frontend edit is judged on its changes", async () => {
    const worldId = await seed({ approvedBefore: true });
    const { seen, stored } = await look(worldId);
    assert.ok(seen.live, "the live card is loaded");
    assert.equal(seen.approved, true);
    assert.equal(seen.live!.ageRating, "sensitive");
    assert.deepEqual(seen.live!.schema, liveSchema);
    assert.deepEqual(seen.schema, heldSchema);
    const scope = chooseReviewScope(seen.live, seen, seen.approved);
    assert.equal(scope.mode, "changes");
    if (scope.mode === "changes") assert.match(scope.changes.code[0]!.text, /New turn counter/);
    assert.equal(stored.outcome, "approved");
  });

  it("a live card no review ever approved gets the whole-card look", async () => {
    const worldId = await seed({ approvedBefore: false });
    const { seen } = await look(worldId);
    assert.equal(seen.approved, false);
    assert.deepEqual(chooseReviewScope(seen.live, seen, seen.approved), { mode: "full", why: "not_approved" });
  });
});

// Two editions of one card (a language group), the second submitted while the
// first is being checked (11/12, Aegis Academy).
async function seedPair() {
  const creatorId = `test-pair-${crypto.randomUUID()}`;
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified) VALUES (${creatorId}, 'Pair', ${`${crypto.randomUUID()}@test.local`}, true)`);
  for (const [id, lang] of [[a, "en"], [b, "zh"]] as const) {
    await db.execute(sql`
      INSERT INTO worlds (id, creator_id, name, description, language, language_group_id, is_published, status, visibility, age_rating, thumbnail_url, schema)
      VALUES (${id}, ${creatorId}, 'Academy', 'A school story.', ${lang}, ${a}, true, 'published', 'public', 'all', 'users/x/cover.png', ${JSON.stringify(liveSchema)}::jsonb)`);
    await db.execute(sql`
      INSERT INTO world_review_submissions (id, world_id, group_key, submitted_by, decision, submission_type, submitted_at, decided_at)
      VALUES (${crypto.randomUUID()}, ${id}, ${a}, ${creatorId}, 'approved', 'initial', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')`);
  }
  const hold = async (id: string) => {
    await db.execute(sql`
      INSERT INTO world_pending_edits (id, world_id, created_by, group_key, schema, reasons, status, thumbnail_url, age_rating, metadata)
      VALUES (${crypto.randomUUID()}, ${id}, ${creatorId}, ${a}, ${JSON.stringify(heldSchema)}::jsonb, '["frontend"]'::jsonb, 'pending', 'users/x/cover.png', 'all',
        ${JSON.stringify({ name: "Academy", description: "A school story." })}::jsonb)`);
    const sub = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO world_review_submissions (id, world_id, group_key, submitted_by, decision, submission_type)
      VALUES (${sub}, ${id}, ${a}, ${creatorId}, 'pending', 'edit')`);
    return sub;
  };
  return { group: a, a, b, hold };
}

const pass = async (): Promise<WorldAiReview> => ({ outcome: "approved", reasons: [], suggested: { contentMode: "limited", audience: null, coverBlur: false }, author: { contentMode: "limited", audience: "all", coverBlur: false }, models: [], at: "" });
const row = async (id: string) => ((await db.execute(sql`SELECT decision, ai_review FROM world_review_submissions WHERE id = ${id}`)) as unknown as { rows: Array<{ decision: string; ai_review: Record<string, unknown> | null }> }).rows[0]!;

describe("world AI review with two editions submitted together", () => {
  before(() => { process.env.WORLD_AI_REVIEW = "1"; });

  it("an edition submitted during the check is never published unseen; both go back for the sweep", async () => {
    const p = await seedPair();
    const first = await p.hold(p.b);
    let second = "";
    const result = await runWorldAiReview(p.group, {
      review: async (e) => { if (!second) second = await p.hold(p.a); return pass(); },
    });
    assert.equal(result, "skipped");
    const r1 = await row(first);
    assert.equal(r1.decision, "pending");
    assert.equal(r1.ai_review, null, "handed back for the sweep, not sent to a person");
    const pending = await db.execute(sql`SELECT count(*)::int n FROM world_pending_edits WHERE group_key = ${p.group} AND status = 'pending'`) as unknown as { rows: Array<{ n: number }> };
    assert.equal(pending.rows[0]!.n, 2, "neither held edit went live");
  });

  it("an edition submitted while the other is being checked steps back instead of going to a person", async () => {
    const p = await seedPair();
    const first = await p.hold(p.b);
    await db.execute(sql`UPDATE world_review_submissions SET ai_review = ${JSON.stringify({ running: new Date().toISOString() })}::jsonb WHERE id = ${first}`);
    const second = await p.hold(p.a);
    let pinged = false;
    const result = await runWorldAiReview(p.group, { review: pass, onHuman: () => { pinged = true; } });
    assert.equal(result, "skipped");
    assert.equal((await row(second)).ai_review, null);
    assert.equal(pinged, false);
  });

  it("an edition submitted while the other waits for a person joins it", async () => {
    const p = await seedPair();
    const first = await p.hold(p.b);
    await db.execute(sql`UPDATE world_review_submissions SET ai_review = ${JSON.stringify({ outcome: "human", reasons: ["minor_sexual"], models: [] })}::jsonb WHERE id = ${first}`);
    const second = await p.hold(p.a);
    const result = await runWorldAiReview(p.group, { review: pass });
    assert.equal(result, "human");
    assert.equal((await row(second)).ai_review?.outcome, "human");
  });

  it("the sweep then checks both editions together and approves them", async () => {
    const p = await seedPair();
    const first = await p.hold(p.b);
    const second = await p.hold(p.a);
    const seen: string[] = [];
    const result = await runWorldAiReview(p.group, { review: async (e) => { seen.push(e.id); return pass(); } });
    assert.equal(result, "approved");
    assert.deepEqual(seen.sort(), [p.a, p.b].sort());
    assert.equal((await row(first)).decision, "approved");
    assert.equal((await row(second)).decision, "approved");
  });
});

describe("isLockTimeout", () => {
  it("knows Postgres' lock timeout however it is wrapped", async () => {
    const { isLockTimeout } = await import("./world-ai-review-run.js");
    assert.equal(isLockTimeout({ code: "55P03", message: "x" }), true);
    assert.equal(isLockTimeout(new Error("canceling statement due to lock timeout")), true);
    assert.equal(isLockTimeout({ message: "Failed query", cause: { code: "55P03" } }), true);
    assert.equal(isLockTimeout(new Error("Nothing to approve.")), false);
    assert.equal(isLockTimeout(null), false);
  });
});
