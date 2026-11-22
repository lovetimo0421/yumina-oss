import assert from "node:assert/strict";
import test, { before } from "node:test";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
import { DEFAULT_SESSION_MEMORY_MODEL, DEFAULT_STORY_SUMMARY_MODEL } from "./background-model-defaults.js";
import { chatModelPick, chatRunModel, storySummaryModels, worldAiModel } from "./role-model.js";

before(async () => {
  assert.equal(process.env.YUMINA_LOCAL_TEST, "1");
  assert.equal(process.env.DATABASE_URL, "");
  await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href);
});

async function playerWith(aiConfig: Record<string, unknown>) {
  const userId = crypto.randomUUID();
  await db.insert(user).values({ id: userId, name: "Role model test", email: `${userId}@test.invalid`, preferences: { aiConfig } });
  return userId;
}

test("with nothing picked, every background AI runs on the platform default", async () => {
  const userId = await playerWith({});
  assert.equal(await chatRunModel(userId, "memory", null), DEFAULT_SESSION_MEMORY_MODEL);
  assert.equal(await chatRunModel(userId, "summary", DEFAULT_STORY_SUMMARY_MODEL), DEFAULT_STORY_SUMMARY_MODEL);
  assert.equal(await worldAiModel(userId, null, null), DEFAULT_STORY_SUMMARY_MODEL);
});

test("the player's default reaches chats that never picked their own", async () => {
  const userId = await playerWith({ roleModels: { memory: "deepseek/deepseek-v4-flash", summary: "@story", world: "moonshotai/kimi-k2.6" }, selectedModel: "anthropic/claude-sonnet-4.6" });
  // A background job saved the platform default into the column: still not a pick.
  assert.equal(await chatRunModel(userId, "memory", DEFAULT_SESSION_MEMORY_MODEL), "deepseek/deepseek-v4-flash");
  assert.equal(await chatRunModel(userId, "summary", null), "anthropic/claude-sonnet-4.6");
  assert.equal(await worldAiModel(userId, null, DEFAULT_STORY_SUMMARY_MODEL), "moonshotai/kimi-k2.6");
});

test("a chat's own pick beats the player's default, and the author's pick beats both for world AIs", async () => {
  const userId = await playerWith({ roleModels: { memory: "deepseek/deepseek-v4-flash", world: "moonshotai/kimi-k2.6" } });
  assert.equal(await chatRunModel(userId, "memory", "openai/gpt-5.4-mini"), "openai/gpt-5.4-mini");
  assert.equal(await worldAiModel(userId, null, "openai/gpt-5.4-mini"), "openai/gpt-5.4-mini");
  assert.equal(await worldAiModel(userId, "google/gemini-3.7-flash", "openai/gpt-5.4-mini"), "google/gemini-3.7-flash");
});

test("saving a panel that shows the followed default does not freeze the chat on it", async () => {
  const userId = await playerWith({ roleModels: { memory: "deepseek/deepseek-v4-flash" } });
  assert.equal(await chatModelPick(userId, "memory", "deepseek/deepseek-v4-flash", null), null);
  assert.equal(await chatModelPick(userId, "memory", DEFAULT_SESSION_MEMORY_MODEL, null), null);
  assert.equal(await chatModelPick(userId, "memory", "openai/gpt-5.4-mini", null), "openai/gpt-5.4-mini");
  // Once a chat has its own pick, any model sent for it is a pick.
  assert.equal(await chatModelPick(userId, "memory", "deepseek/deepseek-v4-flash", "openai/gpt-5.4-mini"), "deepseek/deepseek-v4-flash");
});

test("choosing the platform default moves a chat off its own pick", async () => {
  const userId = await playerWith({});
  assert.equal(await chatModelPick(userId, "memory", DEFAULT_SESSION_MEMORY_MODEL, "openai/gpt-5.4-mini"), DEFAULT_SESSION_MEMORY_MODEL);
  assert.equal(await chatRunModel(userId, "memory", DEFAULT_SESSION_MEMORY_MODEL), DEFAULT_SESSION_MEMORY_MODEL);
  assert.equal(await chatModelPick(userId, "summary", DEFAULT_STORY_SUMMARY_MODEL, "openai/gpt-5.4-mini"), DEFAULT_STORY_SUMMARY_MODEL);
  assert.deepEqual(await storySummaryModels(userId, "openai/gpt-5.4-mini", DEFAULT_STORY_SUMMARY_MODEL), { run: DEFAULT_STORY_SUMMARY_MODEL, keep: DEFAULT_STORY_SUMMARY_MODEL });
});

test("a story summary runs on the player's default while the column keeps the platform default", async () => {
  const userId = await playerWith({ roleModels: { summary: "deepseek/deepseek-v4-flash" } });
  assert.deepEqual(await storySummaryModels(userId, null), { run: "deepseek/deepseek-v4-flash", keep: DEFAULT_STORY_SUMMARY_MODEL });
  assert.deepEqual(await storySummaryModels(userId, "openai/gpt-5.4-mini"), { run: "openai/gpt-5.4-mini", keep: "openai/gpt-5.4-mini" });
  assert.deepEqual(await storySummaryModels(userId, null, "openai/gpt-5.4-mini"), { run: "openai/gpt-5.4-mini", keep: "openai/gpt-5.4-mini" });
});
