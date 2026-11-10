import assert from "node:assert/strict";
import test from "node:test";
import { STUDIO_MODELS, STUDIO_RECOMMENDED_MODEL } from "../../../shared/src/constants/models";
import { groupPlayModels } from "../../../shared/src/constants/model-families";

// Studio rows mirror the Play picker: same-price versions share one row.
test("Studio folds same-price versions into one row and keeps every model reachable", () => {
  const listed = STUDIO_MODELS.filter(m => m.id !== STUDIO_RECOMMENDED_MODEL);
  const groups = groupPlayModels(listed);
  const versions = (lead: string) => groups.find(g => g.variants[0]!.model.id === lead)?.variants.map(v => v.label);
  assert.deepEqual(versions("openai/gpt-6.1-sol"), ["6.1", "5.6"]);
  assert.deepEqual(versions("x-ai/grok-4.3"), ["4.3", "4.20"]);
  assert.deepEqual(groups.flatMap(g => g.variants.map(v => v.model.id)).sort(), listed.map(m => m.id).sort());
  assert.ok(groups.length < listed.length);
});

test("the recommended Studio model is not hidden inside a family row", () => {
  const groups = groupPlayModels(STUDIO_MODELS.filter(m => m.id !== STUDIO_RECOMMENDED_MODEL));
  assert.ok(!groups.some(g => g.variants.some(v => v.model.id === STUDIO_RECOMMENDED_MODEL)));
  assert.ok(groups.some(g => g.variants.some(v => v.model.id === "anthropic/claude-sonnet-5.5")));
});
