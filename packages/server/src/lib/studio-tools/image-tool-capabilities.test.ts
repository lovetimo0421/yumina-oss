import test from "node:test";
import assert from "node:assert/strict";
import { getSmartImageCapabilities, SMART_IMAGE_MODEL } from "@yumina/shared";
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

test("the tool offers exactly the ratios the pinned model accepts", () => {
  const { aspectRatios } = getSmartImageCapabilities(SMART_IMAGE_MODEL);
  assert.deepEqual(imageTool().properties.aspectRatio?.enum, aspectRatios,
    "the schema drifted from the shared capability table — derive it, do not retype it");
});

test("the tool offers exactly the sizes the pinned model accepts", () => {
  const { resolutions } = getSmartImageCapabilities(SMART_IMAGE_MODEL);
  assert.deepEqual(imageTool().properties.resolution?.enum, resolutions);
  assert.ok(resolutions.length > 0, "a pinned model with no size tiers needs the property removed, not left empty");
});

test("a shape or size the model cannot do is corrected, never forwarded", () => {
  // The model can propose anything; the creator confirms a card and only then is
  // a job submitted, so an unsupported value must be fixed here rather than
  // failing after they press Generate.
  const wild = normalizeImageProposal({ prompt: "a keep on a cliff", aspectRatio: "8:1", resolution: "512" });
  assert.ok(wild, "an unsupported ratio must be corrected, not rejected outright");
  const { aspectRatios, resolutions } = getSmartImageCapabilities(SMART_IMAGE_MODEL);
  assert.ok(aspectRatios.includes(wild.aspectRatio), "8:1 is Gemini-only and must not survive");
  assert.ok(!wild.resolution || resolutions.includes(wild.resolution as never), "512 is Gemini-only and must not survive");
});

test("a supported choice is kept as the creator's assistant asked for it", () => {
  const { aspectRatios, resolutions } = getSmartImageCapabilities(SMART_IMAGE_MODEL);
  const ratio = aspectRatios.at(-1)!;   // the least obvious one, not the default
  const size = resolutions.at(-1)!;
  const kept = normalizeImageProposal({ prompt: "a market at dusk", aspectRatio: ratio, resolution: size });
  assert.ok(kept);
  assert.equal(kept.aspectRatio, ratio);
  assert.equal(kept.resolution, size);
});

test("no choice at all still yields a submittable proposal", () => {
  const bare = normalizeImageProposal({ prompt: "a quiet library" });
  assert.ok(bare, "a prompt on its own is a valid proposal");
  const { aspectRatios } = getSmartImageCapabilities(SMART_IMAGE_MODEL);
  assert.ok(aspectRatios.includes(bare.aspectRatio));
  assert.equal(bare.batchSize, 1);
});
