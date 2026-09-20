import test from "node:test";
import assert from "node:assert/strict";
import { getSmartImageCapabilities, SMART_IMAGE_MODEL, SMART_IMAGE_MODELS,
  SMART_IMAGE_ASPECTS, SMART_IMAGE_RESOLUTIONS } from "@yumina/shared";
import { STUDIO_TOOLS } from "./tools.js";
import { normalizeImageProposal } from "./image-proposal.js";

// ─── generate_image capabilities ────────────────────────────────────────────
// The assistant's tool schema is the only description of the generator the model
// ever sees, and it used to be a hand-written list. It drifted: seven ratios in
// the schema against thirteen in the generator, so the assistant could not offer
// shapes the creator could pick for themselves. These tests pin the schema to
// the shared table and to the single model the assistant is allowed to submit.

function imageTool() {
  const tool = STUDIO_TOOLS.find(entry => entry.function?.name === "generate_image");
  assert.ok(tool, "generate_image is no longer in STUDIO_TOOLS");
  return tool.function.parameters as {
    properties: Record<string, { enum?: string[]; type?: string }>;
  };
}

test("the tool offers every model the registry has", () => {
  assert.deepEqual(imageTool().properties.model?.enum, SMART_IMAGE_MODELS.map(model => model.id),
    "the assistant picks its own generator; hiding one removes a capability silently");
});

test("the tool advertises the union of ratios and sizes, not one model's", () => {
  // The model is a parameter now, so a per-model list would hide shapes the
  // other generators can do. Narrowing happens in normalizeImageProposal.
  const union = SMART_IMAGE_ASPECTS.filter(ratio =>
    SMART_IMAGE_MODELS.some(model => (model.aspectRatios as readonly string[]).includes(ratio)));
  assert.deepEqual(imageTool().properties.aspectRatio?.enum, union,
    "the schema drifted from the shared table — derive it, do not retype it");
  assert.deepEqual(imageTool().properties.resolution?.enum, [...SMART_IMAGE_RESOLUTIONS]);
});

test("every advertised model keeps its own ratio list reachable", () => {
  // The union is only honest if each model can still be asked for its own
  // shapes: 8:1 exists on Gemini, 2:1 on Seedream, and both must survive.
  for (const model of SMART_IMAGE_MODELS) {
    const { aspectRatios } = getSmartImageCapabilities(model.id);
    assert.ok(aspectRatios.length > 0, `${model.id} offers no shape at all`);
    for (const ratio of aspectRatios) {
      const kept = normalizeImageProposal({ prompt: "x", model: model.id, aspectRatio: ratio });
      assert.ok(kept);
      assert.equal(kept.aspectRatio, ratio, `${model.id} lost ${ratio}`);
    }
  }
});

test("a shape or size the CHOSEN model cannot do is corrected, never forwarded", () => {
  // 8:1 and 512 exist on Gemini only. Asking Seedream for them must land on
  // something Seedream can render, because the job is submitted after the
  // creator confirms the card — a provider rejection then is too late.
  const wild = normalizeImageProposal({
    prompt: "a keep on a cliff", model: "bytedance-seed/seedream-5-0-lite",
    aspectRatio: "8:1", resolution: "512",
  });
  assert.ok(wild, "an unsupported ratio must be corrected, not rejected outright");
  const { aspectRatios, resolutions } = getSmartImageCapabilities("bytedance-seed/seedream-5-0-lite");
  assert.ok(aspectRatios.includes(wild.aspectRatio), "8:1 reached a model that cannot render it");
  assert.ok(!wild.resolution || resolutions.includes(wild.resolution as never), "512 reached a model without that tier");
});

test("an unknown model falls back to the default instead of being forwarded", () => {
  const made_up = normalizeImageProposal({ prompt: "x", model: "acme/not-a-real-model" });
  assert.ok(made_up);
  assert.equal(made_up.model, SMART_IMAGE_MODEL);
});

test("the model the assistant asked for is the model that gets used", () => {
  const picked = normalizeImageProposal({ prompt: "x", model: "openai/gpt-image-2", aspectRatio: "16:9" });
  assert.ok(picked);
  assert.equal(picked.model, "openai/gpt-image-2");
  assert.equal(picked.aspectRatio, "16:9");
  assert.equal(picked.resolution, undefined, "GPT Image has no size knob, so none should be carried");
});

test("a supported choice is kept as the assistant asked for it", () => {
  const { aspectRatios, resolutions } = getSmartImageCapabilities(SMART_IMAGE_MODEL);
  const ratio = aspectRatios.at(-1)!;   // the least obvious one, not the default
  const size = resolutions.at(-1)!;
  const kept = normalizeImageProposal({ prompt: "a market at dusk", model: SMART_IMAGE_MODEL, aspectRatio: ratio, resolution: size });
  assert.ok(kept);
  assert.equal(kept.aspectRatio, ratio);
  assert.equal(kept.resolution, size);
});

test("the default is reachable without naming anything", () => {
  const bare = normalizeImageProposal({ prompt: "a quiet library" });
  assert.ok(bare);
  assert.equal(bare.model, SMART_IMAGE_MODEL);
});

test("no choice at all still yields a submittable proposal", () => {
  const bare = normalizeImageProposal({ prompt: "a quiet library" });
  assert.ok(bare, "a prompt on its own is a valid proposal");
  const { aspectRatios } = getSmartImageCapabilities(SMART_IMAGE_MODEL);
  assert.ok(aspectRatios.includes(bare.aspectRatio));
  assert.equal(bare.batchSize, 1);
});
