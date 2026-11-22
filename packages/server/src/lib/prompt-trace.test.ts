import test from "node:test";
import assert from "node:assert/strict";
import { createPromptTracer } from "./prompt-trace.js";

test("prompt trace: measures the final list by the segment each message was pushed as", () => {
  const tracer = createPromptTracer();
  const ctx: Array<{ role: string; content: string; sourceMessageId?: string }> = [];
  ctx.push({ role: "system", content: "world lore" });
  tracer.take(ctx, "lore");
  ctx.push({ role: "system", content: "rules" });
  tracer.take(ctx, "platform");
  const history = [
    { role: "system", content: "archived run", sourceMessageId: undefined },
    { role: "user", content: "old", sourceMessageId: "m1" },
    { role: "user", content: "hello", sourceMessageId: "m2" },
  ];
  tracer.takeHistory(history);
  history.splice(2, 0, { role: "system", content: "depth", sourceMessageId: undefined });
  tracer.take(history, "lore-triggered");
  ctx.push(...history);
  ctx.push({ role: "system", content: "vars" });
  tracer.take(ctx, "state");

  // The trim dropped "old"; an untagged message lands as platform.
  const final = ctx.filter((m) => m.content !== "old");
  final.push({ role: "system", content: "contract" });
  const trace = tracer.build(final, { speaker: { id: "b1", name: "矿坑" }, model: "m" });

  const by = Object.fromEntries(trace.segments.map((s) => [s.kind, s]));
  assert.equal(by.lore?.chars, "world lore".length);
  assert.equal(by.platform?.chars, "rules".length + "contract".length);
  assert.equal(by.memory?.chars, "archived run".length);
  assert.equal(by["lore-triggered"]?.chars, "depth".length);
  assert.equal(by.history?.messages, 1);
  assert.equal(trace.historyMessages, 1);
  assert.equal(trace.totalChars, final.reduce((n, m) => n + m.content.length, 0));
  assert.deepEqual(trace.segments.map((s) => s.kind), ["lore", "platform", "lore-triggered", "memory", "history", "state"]);
  assert.equal(trace.speaker?.name, "矿坑");
});

test("prompt trace: a block folded into a message still counts as its own segment", () => {
  const tracer = createPromptTracer();
  const history = [{ role: "user", content: "hello", sourceMessageId: "m1" }];
  tracer.takeHistory(history);
  history[0]!.content += "\n\n<game-state>x</game-state>";
  tracer.tail(history[0]!, "state", "\n\n<game-state>x</game-state>".length);
  const trace = tracer.build(history, { speaker: null, model: "deepseek/deepseek-v3.2" });
  const by = Object.fromEntries(trace.segments.map((s) => [s.kind, s]));
  assert.equal(by.history?.chars, "hello".length);
  assert.equal(by.state?.chars, "\n\n<game-state>x</game-state>".length);
  assert.equal(trace.historyMessages, 1);
  assert.equal(trace.totalChars, history[0]!.content.length);
});
