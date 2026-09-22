import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, preloadTokenizer, PromptBuilder } from "@yumina/engine";
import { setImmediate as yieldForIO } from "node:timers/promises";
import { countPromptTokensCooperatively, forEachCooperatively } from "./cooperative-tokens.js";
import { estimateMessageTokens, selectCompactionWindow } from "./session-compaction-core.js";

test("final prompt trimming yields to HTTP timers even without a summary overflow pass", async () => {
  await preloadTokenizer();
  let counted = 0, timerSawPartialHistory = false;
  const rows = Array.from({ length: 40 }, (_, i) => ({ role: "user" as const,
    get content() {
      counted++;
      const end = performance.now() + 1;
      while (performance.now() < end) { /* slow per-message estimation */ }
      return `Turn ${i}`;
    },
  }));
  const timer = setTimeout(() => { timerSawPartialHistory = counted > 0 && counted < rows.length; }, 0);
  const selected = await new PromptBuilder().buildMessageHistoryAsync(rows, yieldForIO, 10000);
  clearTimeout(timer);
  assert.equal(counted, rows.length);
  assert.equal(timerSawPartialHistory, true);
  assert.equal(selected.length, rows.length);
  selected.forEach((row, i) => assert.equal(row, rows[i]));
});

test("CPU batches let unrelated timers run before the backlog is finished", async () => {
  let processed = 0, timerObservedPartialWork = false;
  const timer = setTimeout(() => { timerObservedPartialWork = processed > 0 && processed < 40; }, 0);
  await forEachCooperatively(Array.from({ length: 40 }, (_, i) => i), item => {
    assert.equal(item, processed++);
    const end = performance.now() + 1;
    while (performance.now() < end) { /* synthetic CPU work */ }
  });
  clearTimeout(timer);
  assert.equal(processed, 40);
  assert.equal(timerObservedPartialWork, true);
});

test("an established overflow never tokenizes older history, and under-budget sums remain exact", async () => {
  await preloadTokenizer();
  const unreadOlderMessage = { get content(): string { throw new Error("Older history must not be scanned"); } };
  const newest = { content: "The newest turn fills this tiny budget." };
  assert.ok(await countPromptTokensCooperatively([unreadOlderMessage, newest], "openrouter/free", 1) > 1);
  const normal = [{ content: "A quiet lawn." }, { content: "戴夫走进了院子。" }];
  const total = normal.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  assert.equal(await countPromptTokensCooperatively(normal, "openrouter/free", total), total);
});

test("prepared summary counts preserve selection and invalidate after content, model, role or attachment changes", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: String(i), role: i % 2 ? "assistant" : "user",
    content: `Turn ${i}: ` + "The plants are waiting for Dave. ".repeat(30), createdAt: new Date(i) }));
  const options = { modelId: "openrouter/free", triggerTokens: 1000, recentTailTokens: 500, minCompactableTokens: 100 };
  const expected = selectCompactionWindow(rows.map(row => ({ ...row })), options);
  await forEachCooperatively(rows, row => { estimateMessageTokens(row, options.modelId); });
  assert.deepEqual(selectCompactionWindow(rows, options), expected);
  const changed = { role: "user", content: "你好世界", attachments: [] as unknown[] };
  estimateMessageTokens(changed, "openrouter/free");
  assert.equal(estimateMessageTokens(changed, "google/gemini-2.5-flash"), estimateMessageTokens({ ...changed }, "google/gemini-2.5-flash"));
  changed.content = "The story has changed.";
  changed.role = "assistant";
  changed.attachments.push({});
  assert.equal(estimateMessageTokens(changed, "openrouter/free"), estimateMessageTokens({ ...changed }, "openrouter/free"));
});

test("image token estimates count toward the history window before bytes are attached", async () => {
  const history = [
    { role: "user" as const, content: "old image", imageTokens: 1600 },
    { role: "assistant" as const, content: "seen" },
    { role: "user" as const, content: "new image", imageTokens: 1600 },
  ];
  const result = await new PromptBuilder().buildMessageHistoryAsync(history, async () => {}, 2000);
  assert.deepEqual(result, history.slice(1));
  assert.ok(await countPromptTokensCooperatively(history, "google/gemini-2.5-flash") > 3200);
});
