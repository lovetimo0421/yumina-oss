import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../env.js";
import { buildTurnWorkflow, turnRoute } from "./illustrate.js";

type Node = { class_type: string; inputs: Record<string, unknown> };
const nodes = (g: Record<string, unknown>, type: string) => Object.values(g as Record<string, Node>).filter((n) => n.class_type === type);
const jpeg = Buffer.from("x");

test("a portrait draws the character from it over the whole frame", () => {
  const g = buildTurnWorkflow({ scene: "1girl, observatory", bodies: [], portraits: [{ name: "a.jpg", jpeg, slot: 0 }] }, 1, "bad");
  const [ipa, ...rest] = nodes(g, "IPAdapterAdvanced");
  assert.equal(rest.length, 0);
  assert.equal(ipa!.inputs.weight_type, "linear");
  assert.equal(ipa!.inputs.attn_mask, undefined);
  assert.equal(nodes(g, "LoadImage")[0]!.inputs.image, "a.jpg");
});

test("two portraits each stay on their own half of a two-person frame", () => {
  const g = buildTurnWorkflow({ scene: "1girl, 1boy", bodies: ["1girl, blue hair", "1boy, black hair"],
    portraits: [{ name: "a.jpg", jpeg, slot: 0 }, { name: "b.jpg", jpeg, slot: 1 }] }, 1, "bad") as Record<string, Node>;
  const ipas = nodes(g, "IPAdapterAdvanced");
  assert.equal(ipas.length, 2);
  const xs = ipas.map((n) => g[(n.inputs.attn_mask as [string, number])[0]]!.inputs.x);
  assert.deepEqual(xs, [0, 832 - 480]);
  // Chained: the second adapter patches the first one's model, the sampler takes the last.
  assert.deepEqual(g.ref1!.inputs.model, ["ref0", 0]);
  assert.deepEqual(g.ks!.inputs.model, ["ref1", 0]);
});

test("only the second character's portrait: it goes to the right half", () => {
  const g = buildTurnWorkflow({ scene: "2girls", bodies: ["1girl", "1girl"], portraits: [{ name: "b.jpg", jpeg, slot: 1 }] }, 1, "bad") as Record<string, Node>;
  const [ipa] = nodes(g, "IPAdapterAdvanced");
  assert.equal(g[(ipa!.inputs.attn_mask as [string, number])[0]]!.inputs.x, 832 - 480);
});

test("no portrait: no adapter, and the house style stays", () => {
  const g = buildTurnWorkflow({ scene: "scenery", bodies: [] }, 1, "bad");
  assert.equal(nodes(g, "IPAdapterAdvanced").length, 0);
});

test("two people share one prompt instead of each getting half the frame", () => {
  const g = buildTurnWorkflow({ scene: "2girls, hug", bodies: ["1girl, silver hair, haori", "1girl, black hair, qipao"] }, 1, "bad") as Record<string, Node>;
  assert.equal(nodes(g, "ConditioningSetArea").length, 0);
  // Each body follows the scene, without its own head count.
  assert.equal(g.pos!.inputs.text, "2girls, hug, silver hair, haori, black hair, qipao");
  assert.deepEqual(g.ks!.inputs.positive, ["pos", 0]);
});

// ── Routes (PER_TURN_IMAGE_EDIT_MODEL / _STORY_MODEL / _EXPLICIT_CHECKPOINT) ──

function withEnv(values: Partial<Record<"PER_TURN_IMAGE_EDIT_MODEL" | "PER_TURN_IMAGE_EDIT_EXPLICIT" | "PER_TURN_IMAGE_STORY_MODEL" | "PER_TURN_IMAGE_EXPLICIT_CHECKPOINT", string>>, run: () => void) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, env[k as keyof typeof env]]));
  Object.assign(env, values);
  try { run(); } finally { Object.assign(env, saved); }
}
const EDIT = "qwen_image_edit_2511_fp8mixed.safetensors";
const STORY = "z-anime-distill-8step-fp8.safetensors";

test("nothing configured: every picture takes the SDXL path, as before", () => {
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: "", PER_TURN_IMAGE_STORY_MODEL: "" }, () => {
    assert.equal(turnRoute({ scene: "1girl", bodies: [], caption: "a woman", portraits: [{ name: "a.jpg", jpeg, slot: 0 }] }), "sdxl");
    assert.equal(turnRoute({ scene: "1girl", bodies: [], caption: "a woman" }), "sdxl");
  });
});

test("portraits go to the edit model, which gets every portrait as a reference image", () => {
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: EDIT, PER_TURN_IMAGE_STORY_MODEL: STORY }, () => {
    const g = buildTurnWorkflow({ scene: "2girls, hug", bodies: ["1girl, a", "1girl, b"], caption: "Two women hug at a station.",
      portraits: [{ name: "b.jpg", jpeg, slot: 1, look: "1girl, adult, red hair" }, { name: "a.jpg", jpeg, slot: 0, look: "1girl, adult, silver hair" }] }, 1, "bad") as Record<string, Node>;
    assert.equal(nodes(g, "IPAdapterAdvanced").length, 0);
    assert.equal(nodes(g, "UNETLoader")[0]!.inputs.unet_name, EDIT);
    const [pos] = nodes(g, "TextEncodeQwenImageEditPlus").filter((n) => n.inputs.prompt);
    // Image order follows the characters' order, whatever order the portraits arrived in.
    assert.equal(g[(pos!.inputs.image1 as [string, number])[0]]!.inputs.image, "a.jpg");
    assert.equal(g[(pos!.inputs.image2 as [string, number])[0]]!.inputs.image, "b.jpg");
    assert.match(pos!.inputs.prompt as string, /^Two women hug at a station\..*image 1 is the character with adult, silver hair; image 2 is the character with adult, red hair/);
  });
});

test("portraits through nudity go to the edit model; a sex act goes to SDXL without the adapter unless allowed", () => {
  const portraits = [{ name: "a.jpg", jpeg, slot: 0 }];
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: EDIT, PER_TURN_IMAGE_EDIT_EXPLICIT: "" }, () => {
    assert.equal(turnRoute({ scene: "nsfw, explicit, 1girl, nude, onsen", bodies: [], caption: "x", explicit: true, portraits }), "edit");
    const act = { scene: "nsfw, explicit, (sex, missionary:1.25), 1girl", bodies: [], caption: "x", explicit: true, portraits };
    assert.equal(turnRoute(act), "sdxl");
    assert.equal(nodes(buildTurnWorkflow(act, 1, "bad"), "IPAdapterAdvanced").length, 0);
  });
  withEnv({ PER_TURN_IMAGE_EDIT_MODEL: EDIT, PER_TURN_IMAGE_EDIT_EXPLICIT: "1" }, () => {
    assert.equal(turnRoute({ scene: "(sex, cowgirl position:1.25), 1girl", bodies: [], explicit: true, portraits }), "edit");
  });
});

test("a plain moment without portraits is drawn by the story model from the caption", () => {
  withEnv({ PER_TURN_IMAGE_STORY_MODEL: STORY }, () => {
    const g = buildTurnWorkflow({ scene: "1girl, kitchen", bodies: [], caption: "A woman kneads dough." }, 7, "bad") as Record<string, Node>;
    assert.equal(nodes(g, "UNETLoader")[0]!.inputs.unet_name, STORY);
    assert.match(g.pos!.inputs.text as string, /^A woman kneads dough\. Anime illustration\. All characters are adults\.$/);
    assert.equal(g.ks!.inputs.seed, 7);
    // No caption, or an explicit moment: SDXL.
    assert.equal(turnRoute({ scene: "1girl", bodies: [] }), "sdxl");
    assert.equal(turnRoute({ scene: "1girl, nude", bodies: [], caption: "x", explicit: true }), "sdxl");
  });
});

test("an explicit moment can use its own SDXL checkpoint; a host recipe keeps its own", () => {
  withEnv({ PER_TURN_IMAGE_EXPLICIT_CHECKPOINT: "waiIllustriousSDXL_v170.safetensors" }, () => {
    const explicit = buildTurnWorkflow({ scene: "1girl, nude", bodies: [], explicit: true }, 1, "bad") as Record<string, Node>;
    assert.equal(explicit.ckpt!.inputs.ckpt_name, "waiIllustriousSDXL_v170.safetensors");
    const plain = buildTurnWorkflow({ scene: "1girl", bodies: [] }, 1, "bad") as Record<string, Node>;
    assert.equal(plain.ckpt!.inputs.ckpt_name, env.PER_TURN_IMAGE_CHECKPOINT);
  });
});
