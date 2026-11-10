import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { agentRuns, studioConversations, user, worldPendingEdits, worldSnapshots, worlds } from "../db/schema.js";
import { streamAgentLoop, type AgentLoopParams } from "./agent.js";
import type { GenerateParams, LLMProvider, StreamChunk, ToolCall } from "../lib/llm/types.js";
import { READ_TOOLS, WRITE_TOOLS } from "../lib/studio-tools/tools.js";
import { listLanguageVariants, resolveVariant } from "../lib/studio-tools/language-variants.js";
import { runWorldOp } from "../lib/world-ops.js";

before(async () => { await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href); });

// Run only through scripts/test-local.mjs (isolated in-memory database).
// A card's language versions are sibling worlds in one language group. The
// assistant on one of them knows the others exist and reaches one only by
// naming it in a tool's `variant` argument.
type Script = (params: GenerateParams) => AsyncIterable<StreamChunk>;
class ScriptedProvider implements LLMProvider {
  calls: GenerateParams[] = [];
  constructor(private scripts: Script[]) {}
  async *generateStream(params: GenerateParams) {
    const script = this.scripts[this.calls.length];
    this.calls.push(params);
    assert.ok(script, "The loop must not issue an unplanned provider request");
    yield* script(params);
  }
  async listModels() { return []; }
}
const usage = { promptTokens: 10, completionTokens: 10, totalTokens: 20 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function step(...calls: ToolCall[]): Script {
  return async function* () {
    for (const toolCall of calls) yield { type: "tool_call_end", content: "", toolCall };
    yield { type: "done", content: "", usage, stopReason: "tool_use" };
  };
}
const done: Script = async function* () {
  yield { type: "text", content: "Done." };
  yield { type: "done", content: "", usage, stopReason: "end_turn" };
};

function cardIn(name: string, intro: string): WorldDefinition {
  return migrateWorldDefinition({ version: "19.0.0", name, description: "", author: "t",
    entries: [{ id: "intro", name: "Intro", content: intro, role: "lore", section: "chat-history", position: 0,
      keywords: [], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: true }],
    variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
}

async function fixture() {
  const userId = crypto.randomUUID();
  const strangerId = crypto.randomUUID();
  const group = crypto.randomUUID();
  await db.insert(user).values([
    { id: userId, name: "Creator", email: `${userId}@test.local` },
    { id: strangerId, name: "Stranger", email: `${strangerId}@test.local` },
  ]);
  const world = async (values: { creatorId: string; language: string; status: string; group?: string | null; card: WorldDefinition }) => {
    const id = crypto.randomUUID();
    await db.insert(worlds).values({ id, creatorId: values.creatorId, name: values.card.name, status: values.status,
      language: values.language, languageGroupId: values.group === undefined ? group : values.group,
      schema: values.card as unknown as Record<string, unknown> });
    return id;
  };
  const zh = await world({ creatorId: userId, language: "zh", status: "draft", card: cardIn("中文版", "中文开场") });
  const en = await world({ creatorId: userId, language: "en", status: "draft", card: cardIn("English", "English opening") });
  const es = await world({ creatorId: userId, language: "es", status: "published", card: cardIn("Español", "Apertura") });
  // In the group but someone else's, and the creator's own card outside it: never reachable.
  const foreign = await world({ creatorId: strangerId, language: "fr", status: "draft", card: cardIn("Français", "Ouverture") });
  const ungrouped = await world({ creatorId: userId, language: "ja", status: "draft", group: null, card: cardIn("日本語", "開幕") });
  const [conversation] = await db.insert(studioConversations).values({ worldId: zh, userId }).returning();
  const [run] = await db.insert(agentRuns).values({ worldId: zh, userId, conversationId: conversation!.id,
    model: "test/byok", status: "running", messages: [{ role: "user", content: "Sync the versions." }] }).returning();
  return { userId, zh, en, es, foreign, ungrouped, runId: run!.id, conversationId: conversation!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function runLoop(f: Fixture, provider: LLMProvider) {
  const [row] = await db.select().from(worlds).where(eq(worlds.id, f.zh));
  const params: AgentLoopParams = {
    runId: f.runId, conversationId: f.conversationId, worldId: f.zh, userId: f.userId,
    world: migrateWorldDefinition(row!.schema as unknown as WorldDefinition),
    messages: [{ role: "user", content: "Sync the versions." }], model: "test/byok",
    provider, isByok: true, apiKeyTier: "regular", iteration: 0, maxIterations: 4,
    tools: [...READ_TOOLS, ...WRITE_TOOLS], context: { mode: "build" },
  };
  const app = new Hono();
  app.post("/loop", c => streamAgentLoop(c, params));
  await (await app.request("/loop", { method: "POST" })).text();
}
async function schemaOf(worldId: string) {
  const [row] = await db.select().from(worlds).where(eq(worlds.id, worldId));
  return migrateWorldDefinition(row!.schema as unknown as WorldDefinition);
}
const toolResults = (params: GenerateParams) => JSON.stringify(params.messages.filter(m => m.role === "tool"));

describe("Studio assistant and a card's language variants", { concurrency: false }, () => {
  it("lists only the creator's own versions in the same group", async () => {
    const f = await fixture();
    const variants = await listLanguageVariants(f.zh, f.userId);
    assert.equal(variants.language, "zh");
    assert.deepEqual(variants.siblings.map(s => [s.language, s.status]), [["en", "draft"], ["es", "published"]]);
    assert.deepEqual(resolveVariant(variants, f.zh, "zh"), { kind: "current" });
    assert.equal(resolveVariant(variants, f.zh, "EN").kind, "sibling");
    assert.equal(resolveVariant(variants, f.zh, f.foreign).kind, "error");
    assert.equal(resolveVariant(variants, f.zh, f.ungrouped).kind, "error");
    // Someone else's card in the group sees nothing of the creator's.
    assert.deepEqual((await listLanguageVariants(f.foreign, f.userId)).siblings, []);
  });

  it("names the variants in the prompt and offers variant on the tools", async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([done]);
    await runLoop(f, provider);
    const system = JSON.stringify(provider.calls[0]!.messages[0]);
    assert.match(system, /Language variants of this card/);
    assert.ok(system.includes(f.en) && system.includes(f.es));
    assert.ok(!system.includes(f.foreign) && !system.includes(f.ungrouped));
    const writeEntry = provider.calls[0]!.tools!.find(t => t.function.name === "write_entry")!;
    assert.ok("variant" in ((writeEntry.function.parameters as { properties: Record<string, unknown> }).properties));
  });

  it("reads a variant's working copy when the tool names it", async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([
      step(call("r-en", "read_entities", { ids: ["intro"], variant: "en" }), call("g-es", "grep_world", { query: "Apertura", variant: "es" })),
      done,
    ]);
    await runLoop(f, provider);
    const results = toolResults(provider.calls[1]!);
    assert.match(results, /English opening/);
    assert.match(results, /Apertura/);
    assert.ok(!results.includes("中文开场"), "The variant read does not return this card's text");
  });

  it("writes a draft variant directly and a published one into its held edit", async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([
      step(
        call("w-en", "write_entry", { id: "intro", content: "New English opening", variant: "en" }),
        call("w-es", "write_entry", { id: "intro", content: "Nueva apertura", variant: "es" }),
      ),
      done,
    ]);
    await runLoop(f, provider);
    assert.equal((await schemaOf(f.en)).entries.find(e => e.id === "intro")?.content, "New English opening");
    assert.equal((await schemaOf(f.es)).entries.find(e => e.id === "intro")?.content, "Apertura", "The live published card is untouched");
    const [held] = await db.select().from(worldPendingEdits).where(eq(worldPendingEdits.worldId, f.es));
    assert.match(JSON.stringify(held?.schema), /Nueva apertura/);
    assert.equal((await schemaOf(f.zh)).entries.find(e => e.id === "intro")?.content, "中文开场", "This card is untouched");
    assert.ok(!JSON.stringify(await schemaOf(f.en)).includes("\"variant\""), "variant is not written into the entry");
    // Each sibling was snapshotted before the change, under this run.
    const snapshots = await db.select().from(worldSnapshots).where(eq(worldSnapshots.agentRunId, f.runId));
    assert.deepEqual(snapshots.map(s => s.worldId).sort(), [f.en, f.es].sort());
    const results = toolResults(provider.calls[1]!);
    assert.match(results, /"variant\\":\\"en「English」/);
    assert.match(results, /held edit/);
  });

  it("refuses another creator's card and a card outside the group", async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([
      step(
        call("w-foreign", "write_entry", { id: "intro", content: "hijack", variant: f.foreign }),
        call("w-out", "write_entry", { id: "intro", content: "hijack", variant: f.ungrouped }),
        call("r-out", "read_entities", { ids: ["intro"], variant: "fr" }),
      ),
      done,
    ]);
    await runLoop(f, provider);
    for (const id of [f.foreign, f.ungrouped, f.zh]) {
      assert.ok(!JSON.stringify(await schemaOf(id)).includes("hijack"));
    }
    const results = JSON.parse(toolResults(provider.calls[1]!)) as Array<{ content: string }>;
    assert.equal(results.length, 3);
    assert.ok(results.every(r => /not a language version of this card/.test(r.content)), JSON.stringify(results));
    assert.equal((await db.select().from(worldSnapshots).where(and(eq(worldSnapshots.agentRunId, f.runId)))).length, 0);
  });

  it("serves variants to an outside AI through the same ops", async () => {
    const f = await fixture();
    const overview = await runWorldOp({ userId: f.userId, worldId: f.zh, name: "get_world", args: {}, actor: "Claude" });
    assert.match(JSON.stringify(overview.result), new RegExp(f.en));
    const read = await runWorldOp({ userId: f.userId, worldId: f.zh, name: "read_entities", args: { ids: ["intro"], variant: "en" }, actor: "Claude" });
    assert.match(JSON.stringify(read.result), /English opening/);
    const written = await runWorldOp({ userId: f.userId, worldId: f.zh, name: "write_entry", args: { id: "intro", content: "Hola", variant: "es" }, actor: "Claude" });
    assert.ok(written.ok, written.error);
    assert.equal((await schemaOf(f.es)).entries[0]?.content, "Apertura");
    const refused = await runWorldOp({ userId: f.userId, worldId: f.zh, name: "read_entities", args: { ids: ["intro"], variant: f.foreign }, actor: "Claude" });
    assert.equal(refused.ok, false);
  });
});
