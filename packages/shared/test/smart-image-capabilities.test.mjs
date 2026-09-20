import assert from "node:assert/strict";
import test from "node:test";
import {
  SMART_IMAGE_ASPECTS,
  SMART_IMAGE_MODELS,
  SMART_IMAGE_MODEL,
  SMART_IMAGE_RESOLUTIONS,
  getSmartImageCapabilities,
  resolveSmartImageAspect,
  resolveSmartImageResolution,
} from "../dist/index.js";

// ─── Smart image capabilities ───────────────────────────────────────────────
// Every ratio and size a creator can click has to be one the provider accepts:
// OpenRouter clamps to each model's own list and 400s on anything else, and by
// then the wallet has already been reserved against. These tables are copied
// from /api/v1/images/models, so the checks below are about keeping the copy
// internally honest. Run with CHECK_OPENROUTER_CAPS=1 to diff against the live
// endpoint (network, so it is opt-in rather than part of the default suite).

test("every model's ratios and sizes come from the shared vocabularies", () => {
  for (const model of SMART_IMAGE_MODELS) {
    assert.ok(model.aspectRatios.length > 0, `${model.id} must offer at least one ratio`);
    for (const ratio of model.aspectRatios) {
      assert.ok(SMART_IMAGE_ASPECTS.includes(ratio),
        `${model.id} lists ${ratio}, which is missing from SMART_IMAGE_ASPECTS`);
    }
    for (const size of model.resolutions) {
      assert.ok(SMART_IMAGE_RESOLUTIONS.includes(size),
        `${model.id} lists ${size}, which is missing from SMART_IMAGE_RESOLUTIONS`);
    }
  }
});

test("each model's default size is one it actually supports", () => {
  for (const model of SMART_IMAGE_MODELS) {
    if (model.resolution === undefined) {
      assert.equal(model.resolutions.length, 0,
        `${model.id} has no default size, so it must not advertise a size picker`);
      continue;
    }
    assert.ok(model.resolutions.includes(model.resolution),
      `${model.id} defaults to ${model.resolution}, which is not in its own list`);
  }
});

test("the capability reader returns options in display order", () => {
  const { aspectRatios } = getSmartImageCapabilities("google/gemini-3.1-flash-image");
  const positions = aspectRatios.map(ratio => SMART_IMAGE_ASPECTS.indexOf(ratio));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b),
    "chips must follow SMART_IMAGE_ASPECTS order so the picker does not reshuffle per model");
  assert.ok(aspectRatios.includes("1:1"));
});

test("a pick the chosen model cannot do falls back instead of reaching the provider", () => {
  // 512 exists only on Gemini 3.1 Flash. Switching to a model without it, or
  // replaying an old recipe, must land on that model's default.
  assert.equal(resolveSmartImageResolution("google/gemini-3.1-flash-image", "512"), "512");
  assert.equal(resolveSmartImageResolution("bytedance-seed/seedream-5-0-lite", "512"), "2K");
  assert.equal(resolveSmartImageResolution("openai/gpt-image-2", "4K"), undefined,
    "GPT Image has no resolution knob at all, so nothing should be sent");

  // 8:1 is Gemini-only; 2:1 is Seedream-only.
  assert.equal(resolveSmartImageAspect("google/gemini-3.1-flash-image", "8:1"), "8:1");
  assert.equal(resolveSmartImageAspect("google/gemini-3-pro-image", "8:1"), "1:1");
  assert.equal(resolveSmartImageAspect("bytedance-seed/seedream-5-0-lite", "2:1"), "2:1");
  assert.equal(resolveSmartImageAspect("openai/gpt-image-2", "2:1"), "1:1");
});

test("jobs created before the picker existed still resolve", () => {
  // Old rows carry no resolution and sometimes no model.
  assert.equal(resolveSmartImageResolution(undefined, undefined), "2K");
  assert.equal(resolveSmartImageAspect(undefined, undefined), "1:1");
  assert.equal(resolveSmartImageResolution(SMART_IMAGE_MODEL, undefined), "2K");
});

test("the default model leads the list the picker renders", () => {
  assert.equal(SMART_IMAGE_MODELS[0].id, SMART_IMAGE_MODEL);
});

test("capabilities still match OpenRouter (opt-in: CHECK_OPENROUTER_CAPS=1)", { skip: !process.env.CHECK_OPENROUTER_CAPS }, async () => {
  const response = await fetch("https://openrouter.ai/api/v1/images/models");
  assert.ok(response.ok, `image models endpoint returned ${response.status}`);
  const { data } = await response.json();
  const live = new Map(data.map(entry => [entry.id, entry.supported_parameters ?? {}]));

  for (const model of SMART_IMAGE_MODELS) {
    const params = live.get(model.id);
    assert.ok(params, `${model.id} is no longer listed by OpenRouter`);
    const liveRatios = params.aspect_ratio?.values ?? [];
    const liveSizes = params.resolution?.values ?? [];
    for (const ratio of model.aspectRatios) {
      assert.ok(liveRatios.includes(ratio), `${model.id} no longer accepts ratio ${ratio}`);
    }
    for (const size of model.resolutions) {
      assert.ok(liveSizes.includes(size), `${model.id} no longer accepts size ${size}`);
    }
  }
});
