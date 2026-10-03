import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnWorkflow } from "./illustrate.js";

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
