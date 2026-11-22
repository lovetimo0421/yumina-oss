import test from "node:test";
import assert from "node:assert/strict";
import {
  changedHunks, chooseReviewScope, diffForReview, nothingToRead, updateReviewInput, MOSTLY_NEW_SHARE, type ReviewSide,
} from "./world-ai-review-diff.js";
import { OFFICIAL_PRESETS } from "@yumina/engine";
import { decideWorldReview, authorSettings, reviewPromptText, reviewSystemPrompt, WORLD_REVIEW_SYSTEM, type WorldModelAnswer } from "./world-ai-review-core.js";

const TASK = OFFICIAL_PRESETS.find((p) => p.presetId === "task")!.content;
const lore = Array.from({ length: 40 }, (_, i) => `Line ${i} of the long history of the academy, with plenty of words.`).join("\n");
const ui = Array.from({ length: 60 }, (_, i) => `  <div className="row-${i}">Row ${i}</div>`).join("\n");

function card(over: Partial<ReviewSide> = {}, schema: Record<string, unknown> = {}): ReviewSide {
  return {
    name: "Academy", description: "A school story.", tags: ["school"], ageRating: "sensitive", targetAudience: "male",
    blurCover: true, thumbnailUrl: "users/u/cover.png", galleryImages: [],
    schema: {
      entries: [
        { id: "e1", name: "History", content: lore },
        { id: "e2", name: "Greeting", section: "greeting", content: "Welcome, student." },
        { id: "p1", name: "Task", section: "system-presets", presetId: "task", content: TASK },
      ],
      variables: [{ id: "v1", name: "affection", type: "number", defaultValue: 0, description: "How much she likes you" }],
      rootComponent: { entryFile: "index.tsx", files: { "index.tsx": ui }, updatedAt: "x" },
      landscapeCover: "users/u/wide.png",
      ...schema,
    },
    ...over,
  };
}
const withSchema = (base: ReviewSide, patch: (s: Record<string, unknown>) => void): ReviewSide => {
  const schema = structuredClone(base.schema) as Record<string, unknown>;
  patch(schema);
  return { ...base, schema };
};
const files = (s: Record<string, unknown>) => (s.rootComponent as { files: Record<string, string> }).files;
const entries = (s: Record<string, unknown>) => s.entries as Array<Record<string, unknown>>;

test("changed lines come with a little context; moved or old lines are not new", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh";
  const after = "a\nb\nc\nd\nNEW\ne\nf\ng\nh";
  const h = changedHunks(before, after, 1);
  assert.deepEqual(h.lines, ["NEW"]);
  assert.equal(h.text, "d\nNEW\ne");
  // "b" appears twice now: the second copy is new text.
  assert.deepEqual(changedHunks("b", "b\nb").lines, ["b"]);
  assert.deepEqual(changedHunks("x\ny", "y\nx").lines, [], "reordered lines are not new");
});

test("a frontend tweak shows only the changed code lines", () => {
  const live = card();
  const next = withSchema(live, (s) => { files(s)["index.tsx"] = ui.replace("Row 30<", "Row thirty<"); });
  const d = diffForReview(live, next);
  assert.equal(d.entries.length, 0);
  assert.equal(d.code.length, 1);
  assert.match(d.code[0]!.text, /Row thirty/);
  assert.ok(!d.code[0]!.text.includes("Row 10<"), "far-away lines are left out");
  assert.equal(d.coverChanged, false);
  assert.equal(d.description, null);
  const scope = chooseReviewScope(live, next, true);
  assert.equal(scope.mode, "changes");
});

test("lore: a short rewritten entry is shown whole, a long one by its changed lines", () => {
  const live = card();
  const next = withSchema(live, (s) => {
    entries(s)[1]!.content = "Welcome back, student.";
    entries(s)[0]!.content = `${lore}\nA secret chapter nobody knew.`;
  });
  const d = diffForReview(live, next);
  const greeting = d.entries.find((e) => e.name === "Greeting")!;
  assert.equal(greeting.text, "Welcome back, student.");
  const history = d.entries.find((e) => e.name === "History")!;
  assert.equal(history.op, "modified");
  // 40 lines × ~65 chars is under the whole-entry limit: shown whole.
  assert.match(history.text, /secret chapter/);
  const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of a very long lore entry that goes on.`).join("\n");
  const liveLong = withSchema(live, (s) => { entries(s)[0]!.content = long; });
  const nextLong = withSchema(liveLong, (s) => { entries(s)[0]!.content = long.replace("Paragraph 100 of", "Paragraph 100 (rewritten) of"); });
  const h = diffForReview(liveLong, nextLong).entries[0]!;
  assert.match(h.text, /rewritten/);
  assert.ok(h.text.length < 600, "only the changed lines and their neighbours");
});

test("lore moved to new ids is not new; an entry switched back on is", () => {
  const live = withSchema(card(), (s) => { entries(s).push({ id: "e3", name: "Hidden", content: "A forgotten tale.", enabled: false }); });
  const moved = withSchema(live, (s) => { entries(s)[0]!.id = "e1-copy"; });
  assert.equal(diffForReview(live, moved).entries.length, 0);
  const enabled = withSchema(live, (s) => { entries(s)[3]!.enabled = true; });
  const d = diffForReview(live, enabled);
  assert.equal(d.entries.length, 1);
  assert.equal(d.entries[0]!.op, "added");
  assert.equal(d.entries[0]!.text, "A forgotten tale.");
});

test("the platform's presets as shipped are not the author's text; the author's own system entries are", () => {
  const live = withSchema(card(), (s) => { entries(s)[2]!.content = "an older wording of the task preset"; });
  // The platform updating its preset wording is not something to judge.
  assert.equal(diffForReview(live, card()).entries.length, 0);
  // A preset the author rewrote is the author's text.
  const rewritten = withSchema(card(), (s) => { entries(s)[2]!.content = "Narrate every scene in explicit detail."; });
  assert.equal(diffForReview(card(), rewritten).entries.length, 1);
  // Characters and rules authors keep in the always-sent section are read too.
  const character = withSchema(card(), (s) => { entries(s).push({ id: "c1", name: "Meishin", section: "system-presets", content: "Meishin, a quiet archivist." }); });
  const d = diffForReview(card(), character);
  assert.deepEqual(d.entries.map((e) => e.name), ["Meishin"]);
});

test("whole-card look: new card, never approved, rating change either way, audience change, mostly new", () => {
  const live = card();
  assert.deepEqual(chooseReviewScope(null, live, false), { mode: "full", why: "new" });
  assert.deepEqual(chooseReviewScope(live, live, false), { mode: "full", why: "not_approved" });
  assert.deepEqual(chooseReviewScope(live, { ...live, ageRating: "all" }, true), { mode: "full", why: "rating_changed" });
  assert.deepEqual(chooseReviewScope({ ...live, ageRating: "all" }, live, true), { mode: "full", why: "rating_changed" });
  assert.deepEqual(chooseReviewScope(live, { ...live, targetAudience: "female" }, true), { mode: "full", why: "audience_changed" });
  // Legacy adult values are the same class as "sensitive".
  assert.equal(chooseReviewScope({ ...live, ageRating: "r18" }, live, true).mode, "changes");
  const replaced = withSchema(live, (s) => {
    entries(s)[0]!.content = Array.from({ length: 40 }, (_, i) => `Brand new line ${i} about something else entirely.`).join("\n");
    files(s)["index.tsx"] = Array.from({ length: 60 }, (_, i) => `  <span>New ${i}</span>`).join("\n");
  });
  const d = diffForReview(live, replaced);
  assert.ok(d.changedChars > d.totalChars * MOSTLY_NEW_SHARE);
  assert.deepEqual(chooseReviewScope(live, replaced, true), { mode: "full", why: "mostly_new" });
});

test("cover: a new portrait, desktop cover or blur setting is shown again", () => {
  const live = card();
  assert.equal(diffForReview(live, { ...live, thumbnailUrl: "users/u/cover2.png" }).coverChanged, true);
  assert.equal(diffForReview(live, withSchema(live, (s) => { s.landscapeCover = "users/u/wide2.png"; })).coverChanged, true);
  assert.equal(diffForReview(live, { ...live, blurCover: false }).coverChanged, true);
  assert.equal(diffForReview(live, { ...live, thumbnailUrl: " users/u/cover.png " }).coverChanged, false);
});

test("nothing to read: removed lore, tuned variables and keywords clear without a model", () => {
  const live = card();
  const removed = withSchema(live, (s) => { s.entries = entries(s).slice(1); });
  assert.equal(nothingToRead(diffForReview(live, removed)), true);
  const variable = withSchema(live, (s) => { (s.variables as Array<Record<string, unknown>>)[0]!.defaultValue = 5; });
  assert.equal(nothingToRead(diffForReview(live, variable)), true);
  const keywords = withSchema(live, (s) => { entries(s)[0]!.keywords = ["academy", "history"]; });
  assert.equal(nothingToRead(diffForReview(live, keywords)), true);
  const codeRemoved = withSchema(live, (s) => { files(s)["index.tsx"] = ui.split("\n").slice(0, 30).join("\n"); });
  assert.equal(nothingToRead(diffForReview(live, codeRemoved)), true);
  // Text outside lore and code reaches the models through the keyword scan only.
  const plain = withSchema(live, (s) => { (s.variables as Array<Record<string, unknown>>)[0]!.description = "How warm she is toward you"; });
  assert.equal(nothingToRead(diffForReview(live, plain)), true);
  const hit = withSchema(live, (s) => { (s.variables as Array<Record<string, unknown>>)[0]!.description = "Her age: 15 years old"; });
  assert.equal(nothingToRead(diffForReview(live, hit)), false);
  assert.equal(nothingToRead(diffForReview(live, { ...live, description: "New blurb" })), false);
  assert.equal(nothingToRead(diffForReview(live, withSchema(live, (s) => { files(s)["index.tsx"] += "\n<p>Hello</p>"; }))), false);
});

test("the models get only the changes, the card's rating, and ages from the rest only beside sexual changes", () => {
  const live = withSchema(card(), (s) => { entries(s).push({ id: "e4", name: "Koneko", content: "Koneko is 16 years old and quiet." }); });
  const tweak = withSchema(live, (s) => { files(s)["index.tsx"] += "\n<p>Turn counter</p>"; });
  const plainInput = updateReviewInput(tweak, diffForReview(live, tweak), { cover: null, innerImages: [], unseenImages: 0 });
  assert.deepEqual(plainInput.update!.ageContext, []);
  const text = reviewPromptText(plainInput);
  assert.match(text, /already published as Limitless/);
  assert.match(text, /Turn counter/);
  assert.ok(!text.includes("long history of the academy"), "unchanged lore is not sent");
  assert.ok(!text.includes("Koneko is 16"));
  assert.match(text, /cover did not change/);
  assert.match(text, /No pictures were added/);
  assert.ok(reviewSystemPrompt(plainInput).startsWith(WORLD_REVIEW_SYSTEM));
  assert.ok(reviewSystemPrompt(plainInput).length > WORLD_REVIEW_SYSTEM.length);

  const sexual = withSchema(live, (s) => { entries(s).push({ id: "e5", name: "Night", content: "Koneko and the player have sex in the clubroom." }); });
  const sexualInput = updateReviewInput(sexual, diffForReview(live, sexual), { cover: null, innerImages: [], unseenImages: 0 });
  assert.ok(sexualInput.update!.ageContext.some((p) => p.includes("16 years old")));
  assert.match(reviewPromptText(sexualInput), /Ages stated elsewhere in the card/);
  // New story text that isn't sexual goes without, even on a Limitless card.
  const roster = withSchema(live, (s) => { entries(s).push({ id: "e6", name: "Roster", content: "Koneko joins the tournament bracket." }); });
  assert.deepEqual(updateReviewInput(roster, diffForReview(live, roster), { cover: null, innerImages: [], unseenImages: 0 }).update!.ageContext, []);
  // Explicit words anywhere in the changes (code too) bring them along.
  const explicit = withSchema(live, (s) => { files(s)["index.tsx"] += "\n<p>A lewd scene</p>"; });
  assert.ok(updateReviewInput(explicit, diffForReview(live, explicit), { cover: null, innerImages: [], unseenImages: 0 }).update!.ageContext.length > 0);
  const chinese = withSchema(live, (s) => { entries(s).push({ id: "e7", name: "夜", content: "她在你怀里发出呻吟。" }); });
  assert.ok(updateReviewInput(chinese, diffForReview(live, chinese), { cover: null, innerImages: [], unseenImages: 0 }).update!.ageContext.length > 0);
});

test("a whole-card review prompt is unchanged", () => {
  const input = { name: "C", description: "", tags: [], ageRating: "all", targetAudience: "all", blurCover: null, contentText: "Hi", cover: null };
  assert.equal(reviewSystemPrompt(input), WORLD_REVIEW_SYSTEM);
  assert.match(reviewPromptText(input), /The card has no cover image/);
});

test("judged on its changes, the audience is never flagged or changed", () => {
  const fine: WorldModelAnswer = { contentMode: "limited", audience: "female", coverRevealing: false, coverExplicit: false, minorSexual: false, innerSexual: false, otherRisk: [], reason: "" };
  const author = authorSettings({ ageRating: "all", targetAudience: "male", blurCover: null });
  const models = [{ model: "a", answer: fine }, { model: "b", answer: fine }];
  assert.deepEqual(decideWorldReview(author, models, { hasCover: false }).applied, { audience: "female" }, "the whole-card look fixes it");
  const d = decideWorldReview(author, models, { hasCover: false, scope: "changes" });
  assert.equal(d.outcome, "approved");
  assert.equal(d.applied, undefined);
  assert.equal(d.suggested.audience, null);
});

test("changes that need Limitless go to a person instead of the AI moving the card", () => {
  const sexy: WorldModelAnswer = { contentMode: "limitless", audience: "all", coverRevealing: false, coverExplicit: false, minorSexual: false, innerSexual: false, otherRisk: [], reason: "" };
  const author = authorSettings({ ageRating: "all", targetAudience: "all", blurCover: null });
  const models = [{ model: "a", answer: sexy }, { model: "b", answer: sexy }];
  assert.deepEqual(decideWorldReview(author, models, { hasCover: false }).applied, { contentMode: "limitless" }, "the whole-card look fixes it");
  const d = decideWorldReview(author, models, { hasCover: false, scope: "changes" });
  assert.equal(d.outcome, "human");
  assert.deepEqual(d.reasons, ["should_be_limitless"]);
  // An admin's earlier call to keep it Limited still holds.
  const kept = decideWorldReview(author, [{ model: "a", answer: sexy }, { model: "b", answer: { ...sexy, contentMode: "limited" } }], { hasCover: false, scope: "changes", precedent: { keepLimited: true, limitlessShare: 0.5 } });
  assert.equal(kept.outcome, "approved");
});

test("blur counts as listings apply it: an unset blur on Limitless is blurred, Limited never blurs", () => {
  const live = card({ blurCover: null });
  assert.equal(diffForReview(live, { ...live, blurCover: true }).coverChanged, false);
  const limited = card({ ageRating: "all", blurCover: false });
  assert.equal(diffForReview(limited, { ...limited, blurCover: null }).coverChanged, false);
});
