import test from "node:test";
import assert from "node:assert/strict";
import { reviewWorld, WORLD_REVIEW_FALLBACK_MODEL, type WorldReviewInput } from "./world-ai-review.js";

const input: WorldReviewInput = {
  name: "Card", description: "", tags: [], ageRating: "all", targetAudience: "all", blurCover: null,
  contentText: "Hello", cover: null,
};
const fine = { contentMode: "limited", audience: "all", coverRevealing: false, coverExplicit: false, minorSexual: false, innerSexual: false, otherRisk: [], reason: "Looks fine." };

test("a busy model gets one more try before the card goes to a person", async () => {
  const calls: string[] = [];
  let busy = true;
  const review = await reviewWorld(input, "u", {
    models: ["m1", "m2"], retryDelayMs: 0,
    ask: async (model) => { calls.push(model); if (model === "m1" && busy) { busy = false; throw new Error("OpenRouter error (502): at capacity"); } return fine; },
  });
  assert.equal(review.outcome, "approved");
  assert.deepEqual(calls.filter((m) => m === "m1").length, 2);
});

test("on a Limitless card, a content-filter refusal goes straight to the fallback model", async () => {
  const calls: string[] = [];
  const review = await reviewWorld({ ...input, ageRating: "sensitive" }, "u", {
    models: ["m1", "gemini"], retryDelayMs: 0,
    ask: async (model) => { calls.push(model); if (model === "gemini") throw new Error("Response blocked by safety/content filter"); return { ...fine, contentMode: "limitless" }; },
  });
  assert.equal(review.outcome, "approved");
  assert.deepEqual(calls.filter((m) => m === "gemini").length, 1, "no second try at a model that refused");
  assert.ok(calls.includes(WORLD_REVIEW_FALLBACK_MODEL));
  assert.ok(review.models.some((m) => m.model === WORLD_REVIEW_FALLBACK_MODEL && m.answer));
});

test("if the fallback fails too, the card waits for a person", async () => {
  const review = await reviewWorld(input, "u", {
    models: ["m1", "m2"], retryDelayMs: 0,
    ask: async (model) => { if (model === "m2" || model === WORLD_REVIEW_FALLBACK_MODEL) throw new Error("down"); return fine; },
  });
  assert.equal(review.outcome, "human");
  assert.deepEqual(review.reasons, ["ai_failed"]);
});

test("a split on minors for a non-sexual card goes to a third model, and two noes clear it", async () => {
  const calls: string[] = [];
  const review = await reviewWorld(input, "u", {
    models: ["m1", "m2"], retryDelayMs: 0,
    ask: async (model) => { calls.push(model); return model === "m1" ? { ...fine, minorSexual: true, reason: "Characters are 14." } : fine; },
  });
  assert.equal(review.outcome, "approved");
  assert.ok(review.models.some((m) => m.tiebreak && m.model === WORLD_REVIEW_FALLBACK_MODEL && m.answer?.minorSexual === false));
  assert.equal(calls.filter((m) => m === WORLD_REVIEW_FALLBACK_MODEL).length, 1);
});

test("the third model siding with the yes keeps minor_risk, and so does a failed tie-break", async () => {
  const yes = await reviewWorld(input, "u", {
    models: ["m1", "m2"], retryDelayMs: 0,
    ask: async (model) => (model === "m2" ? fine : { ...fine, minorSexual: true }),
  });
  assert.equal(yes.outcome, "human");
  assert.ok(yes.reasons.includes("minor_risk"));
  const down = await reviewWorld(input, "u", {
    models: ["m1", "m2"], retryDelayMs: 0,
    ask: async (model) => { if (model === WORLD_REVIEW_FALLBACK_MODEL) throw new Error("down"); return model === "m1" ? { ...fine, minorSexual: true } : fine; },
  });
  assert.equal(down.outcome, "human");
  assert.ok(down.reasons.includes("minor_risk"));
});

test("no tie-break when a model reads the card as sexual: a minor flag there always goes to a person", async () => {
  const calls: string[] = [];
  const review = await reviewWorld({ ...input, ageRating: "sensitive" }, "u", {
    models: ["m1", "m2"], retryDelayMs: 0,
    ask: async (model) => { calls.push(model); return model === "m1" ? { ...fine, contentMode: "limitless", minorSexual: true } : { ...fine, contentMode: "limitless" }; },
  });
  assert.equal(review.outcome, "human");
  assert.ok(review.reasons.includes("minor_risk"));
  assert.ok(!calls.includes(WORLD_REVIEW_FALLBACK_MODEL));
});

test("no vote can clear a minor flag on a card filed as Limitless, with a revealing cover, or when the tie-breaker reads it as sexual", async () => {
  const split = (extra: Record<string, unknown>, third: Record<string, unknown> = fine) => async (model: string) =>
    model === WORLD_REVIEW_FALLBACK_MODEL ? third : model === "m1" ? { ...fine, ...extra, minorSexual: true } : { ...fine, ...extra };
  const limitless = await reviewWorld({ ...input, ageRating: "sensitive" }, "u", { models: ["m1", "m2"], retryDelayMs: 0, ask: split({}) });
  assert.ok(limitless.reasons.includes("minor_risk"));
  assert.ok(!limitless.models.some((m) => m.tiebreak));
  const cover = await reviewWorld({ ...input, cover: Buffer.from("x") }, "u", { models: ["m1", "m2"], retryDelayMs: 0, ask: split({ coverRevealing: true }) });
  assert.ok(cover.reasons.includes("minor_risk"));
  const sexualThird = await reviewWorld(input, "u", { models: ["m1", "m2"], retryDelayMs: 0, ask: split({}, { ...fine, contentMode: "limitless" }) });
  assert.ok(sexualThird.models.some((m) => m.tiebreak));
  assert.ok(sexualThird.reasons.includes("minor_risk"));
});

test("a split on Limited vs Limitless from the text alone gets a third vote; two Limited votes clear it", async () => {
  const ask = (third: Record<string, unknown>) => async (model: string) =>
    model === WORLD_REVIEW_FALLBACK_MODEL ? third : model === "m2" ? { ...fine, contentMode: "limitless", reason: "Offers an R18 setting." } : fine;
  const cleared = await reviewWorld(input, "u", { models: ["m1", "m2"], retryDelayMs: 0, ask: ask(fine) });
  assert.equal(cleared.outcome, "approved");
  assert.ok(cleared.models.some((m) => m.tiebreak));
  const held = await reviewWorld(input, "u", { models: ["m1", "m2"], retryDelayMs: 0, ask: ask({ ...fine, contentMode: "limitless" }) });
  // Two of three say Limitless: the AI sets it and publishes (11/08).
  assert.equal(held.outcome, "approved");
  assert.deepEqual(held.applied, { contentMode: "limitless" });
});

test("no rating vote when any model sees sexual pictures, an explicit cover or minors", async () => {
  for (const extra of [{ innerSexual: true }, { coverExplicit: true }, { minorSexual: true }]) {
    const calls: string[] = [];
    const review = await reviewWorld({ ...input, cover: Buffer.from("x") }, "u", {
      models: ["m1", "m2"], retryDelayMs: 0,
      ask: async (model) => { calls.push(model); return model === "m2" ? { ...fine, contentMode: "limitless", ...extra } : fine; },
    });
    assert.ok(!calls.includes(WORLD_REVIEW_FALLBACK_MODEL), JSON.stringify(extra));
    // Sexual pictures seen by one model go to a person too (5f18a2c5f, 11/09:
    // the models misjudge pictures, so they alone never move a card to Limitless).
    assert.equal(review.outcome, "human", JSON.stringify(extra));
    assert.ok(review.reasons.includes("should_be_limitless"), JSON.stringify(extra));
  }
});

test("a content filter refusing a card filed as Limited sends it to a person (no stand-in)", async () => {
  const calls: string[] = [];
  const review = await reviewWorld(input, "u", {
    models: ["m1", "gemini"], retryDelayMs: 0,
    ask: async (model) => { calls.push(model); if (model === "gemini") throw new Error("Response blocked by safety/content filter"); return fine; },
  });
  assert.equal(review.outcome, "human");
  assert.ok(!calls.includes(WORLD_REVIEW_FALLBACK_MODEL));
});
