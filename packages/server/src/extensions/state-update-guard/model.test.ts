import "../../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { user, apiKeys, modelPrices } from "../../db/schema.js";
import { env } from "../../lib/env.js";
import { encryptApiKey } from "../../lib/crypto.js";
import { invalidateModelPriceCache } from "../../lib/model-price-cache.js";
import { resolveGuardModel, resolveGuardModelSelection } from "./model.js";
import { edition } from "../../edition/index.js";

test("correction routing enforces protected cards, official plan access and no silent private fallback", { skip: !edition.info().features.officialModels }, async () => {
  const owner = `guard-model-${crypto.randomUUID()}`;
  const pricedModels = ["test/guard-free", "test/guard-premium"];
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  const oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("No network permitted in model resolution test"); };
  env.YUMINA_OPENROUTER_KEY = "test-only-not-a-real-provider-key";
  const encrypted = encryptApiKey("test-only-custom-key");
  await db.insert(user).values({ id: owner, name: "Guard model owner", email: `${owner}@test.local`, preferences: { preferredProvider: "private" } });
  await db.insert(apiKeys).values({ userId: owner, provider: "custom", encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag, baseUrl: "https://example.invalid/v1" });
  await db.insert(modelPrices).values(pricedModels.map((modelId, index) => ({ modelId, inputPricePerM: 1, outputPricePerM: 1, minPlan: index ? "ultra" : "free" })));
  await invalidateModelPriceCache();
  try {
    const custom = await resolveGuardModel(owner, "custom/guard-unknown", false);
    assert.equal(custom.apiKeyTier, "byok");
    assert.equal(custom.model, "custom/guard-unknown");
    assert.equal(custom.maxContext, 28_608, "unknown custom model retains the bounded correction context");
    await assert.rejects(resolveGuardModel(owner, "custom/guard-unknown", true), /no available provider/);
    await assert.rejects(resolveGuardModel(owner, "local/guard", true), /no available provider/);
    await assert.rejects(resolveGuardModel(owner, pricedModels[0]!, false), /no available provider/, "private mode cannot silently use the available official key");
    const selectedOfficial = await resolveGuardModel(owner, `official::${pricedModels[0]}`, false);
    assert.equal(selectedOfficial.model, pricedModels[0], "routing tag never reaches provider model id");
    assert.notEqual(selectedOfficial.apiKeyTier, "byok", "explicit official selection works while story uses BYOK");
    await assert.rejects(resolveGuardModel(owner, `official::${pricedModels[1]}`, false), /not available on your plan/);
    await assert.rejects(resolveGuardModel(owner, "official::custom/guard-unknown", false), /no available provider/);
    await assert.rejects(resolveGuardModel(owner, "private::custom/guard-unknown", true), /does not allow private/);
    const [unchanged] = await db.select().from(user).where(eq(user.id, owner));
    assert.equal((unchanged!.preferences as { preferredProvider: string }).preferredProvider, "private");

    await db.update(user).set({ preferences: { preferredProvider: "official" } }).where(eq(user.id, owner));
    assert.equal((await resolveGuardModel(owner, "private::custom/guard-unknown", false)).apiKeyTier, "byok", "explicit private selection works while story uses official");
    const official = await resolveGuardModel(owner, pricedModels[0]!, true);
    assert.notEqual(official.apiKeyTier, "byok");
    assert.equal(official.model, pricedModels[0]);
    await assert.rejects(resolveGuardModel(owner, pricedModels[1]!, true), /not available on your plan/);
    assert.equal(requests, 0, "saving or resolving a correction model must not send a generation request");
  } finally {
    globalThis.fetch = oldFetch; env.YUMINA_OPENROUTER_KEY = oldKey;
    await db.delete(user).where(eq(user.id, owner));
    await db.delete(modelPrices).where(inArray(modelPrices.modelId, pricedModels));
    await invalidateModelPriceCache();
  }
});

test("Guard model defaults preserve hosted paid choice and make imported local chats BYOK-only", () => {
  assert.equal(resolveGuardModelSelection(null, "custom/story", true), "official::google/gemini-2.5-flash-lite");
  assert.equal(resolveGuardModelSelection("official::premium/model", "custom/story", true), "official::premium/model");
  assert.equal(resolveGuardModelSelection(null, "custom/story", false), "private::custom/story");
  assert.equal(resolveGuardModelSelection("official::premium/model", "custom/story", false), "private::custom/story");
  assert.equal(resolveGuardModelSelection("custom/repair", "custom/story", false), "private::custom/repair");
  assert.equal(resolveGuardModelSelection("private::custom/repair", "custom/story", false), "private::custom/repair");
});

test("local Guard rejects official selections and forces BYOK even with imported official account preference", async (t) => {
  const info = edition.info();
  t.mock.method(edition, "info", () => ({ ...info, features: { ...info.features, officialModels: false, billing: false } }));
  const owner = `guard-local-${crypto.randomUUID()}`;
  const encrypted = encryptApiKey("test-only-local-key");
  await db.insert(user).values({ id: owner, name: "Local owner", email: `${owner}@test.local`, preferences: { preferredProvider: "official" } });
  await db.insert(apiKeys).values({ userId: owner, provider: "custom", encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag, baseUrl: "https://example.invalid/v1" });
  try {
    const resolved = await resolveGuardModel(owner, "custom/local-repair", false);
    assert.equal(resolved.apiKeyTier, "byok");
    assert.equal(resolved.model, "custom/local-repair");
    await assert.rejects(resolveGuardModel(owner, "official::google/gemini-2.5-flash-lite", false), /unavailable in this edition/);
    await assert.rejects(resolveGuardModel(owner, "official::openrouter/free", false), /unavailable in this edition/);
    await assert.rejects(resolveGuardModel(owner, "custom/local-repair", true), /unavailable in this edition/);
  } finally { await db.delete(user).where(eq(user.id, owner)); }
});
