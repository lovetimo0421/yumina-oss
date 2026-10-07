import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, Worldbook } from "@yumina/engine";
import {
  applyRunTransitions,
  attachRunSummary,
  buildContextInputBlocks,
  detectRunTransitions,
  foldClosedRuns,
  formatRunMemoryBlock,
  promptHistory,
  scopeRowsToOwnRuns,
  type RunMemories,
} from "./run-scopes.js";

const dungeon: Worldbook = {
  id: "wb-happy-home",
  name: "副本：幸福之家",
  activation: { mode: "conditions", conditions: [{ variableId: "active-dungeon-id", operator: "eq", value: "happy-home" }], conditionLogic: "all" },
  runScoped: true,
  order: 0,
};
const plainBook: Worldbook = {
  id: "wb-plain",
  name: "常驻设定",
  activation: { mode: "always" },
  order: 1,
};

const state = (dungeonId: string): GameState =>
  ({ variables: { "active-dungeon-id": dungeonId }, turnCount: 0 }) as unknown as GameState;

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const row = (minute: number, role = "assistant", content = `m${minute}`) => ({
  role,
  content,
  createdAt: at(minute),
});

// ── detection ──

test("detectRunTransitions sees a runScoped module open and close, ignores plain books", () => {
  const books = [dungeon, plainBook];
  const opened = detectRunTransitions(books, state(""), state("happy-home"));
  assert.deepEqual(opened, { opened: ["wb-happy-home"], closed: [] });
  const closedT = detectRunTransitions(books, state("happy-home"), state(""));
  assert.deepEqual(closedT, { opened: [], closed: ["wb-happy-home"] });
  const steady = detectRunTransitions(books, state("happy-home"), state("happy-home"));
  assert.deepEqual(steady, { opened: [], closed: [] });
});

test("detectRunTransitions is empty when no book is runScoped", () => {
  const books = [{ ...dungeon, runScoped: undefined }, plainBook];
  const t = detectRunTransitions(books, state(""), state("happy-home"));
  assert.deepEqual(t, { opened: [], closed: [] });
});

// ── transitions → memories ──

test("open then close produces a pending record with the right span and index", () => {
  const t1 = applyRunTransitions(undefined, { opened: ["wb-happy-home"], closed: [] }, at(10));
  assert.deepEqual(t1.memories.open, { "wb-happy-home": { fromAt: at(10), runIndex: 1 } });

  const t2 = applyRunTransitions(t1.memories, { opened: [], closed: ["wb-happy-home"] }, at(30));
  assert.equal(t2.closedRecords.length, 1);
  const rec = t2.closedRecords[0]!;
  assert.equal(rec.fromAt, at(10));
  assert.equal(rec.toAt, at(30));
  assert.equal(rec.runIndex, 1);
  assert.equal(rec.summaryStatus, "pending");
  assert.equal(t2.memories.open, undefined);

  // Second attempt numbers itself 2.
  const t3 = applyRunTransitions(t2.memories, { opened: ["wb-happy-home"], closed: [] }, at(40));
  assert.equal(t3.memories.open!["wb-happy-home"]!.runIndex, 2);
});

test("a close with no open marker folds nothing (untracked run)", () => {
  const t = applyRunTransitions(undefined, { opened: [], closed: ["wb-happy-home"] }, at(30));
  assert.equal(t.closedRecords.length, 0);
  assert.equal(t.memories.closed, undefined);
});

// ── folding ──

function closedMemories(from: number, to: number, extra?: Partial<RunMemories>): RunMemories {
  return {
    closed: [
      { bookId: "wb-happy-home", runIndex: 1, fromAt: at(from), toAt: at(to), closedAt: at(to), summaryStatus: "pending" },
    ],
    ...extra,
  };
}

test("foldClosedRuns replaces the run span with one memory block and keeps the rest", () => {
  const rows = [row(1), row(12), row(15), row(20), row(35)];
  // run spanned minutes 10..30 (closed via PATCH at minute 30, after m20)
  const result = foldClosedRuns(rows, closedMemories(10, 30), [dungeon, plainBook], new Set());
  assert.equal(result.foldedMessageCount, 3);
  assert.equal(result.foldedRunCount, 1);
  assert.equal(result.rows.length, 3); // m1, block, m35
  assert.equal(result.rows[0]!.content, "m1");
  assert.match(result.rows[1]!.content, /副本记忆 · 副本：幸福之家 · 第1次/);
  assert.match(result.rows[1]!.content, /记忆正在整理中/);
  assert.equal(result.rows[2]!.content, "m35");
});

test("a ready summary lands in the block verbatim", () => {
  const memories = closedMemories(10, 30);
  memories.closed![0]!.summary = "队伍死了两次，最终用镜子破解了母亲。";
  memories.closed![0]!.summaryStatus = "ready";
  const result = foldClosedRuns([row(12), row(35)], memories, [dungeon], new Set());
  assert.match(result.rows[0]!.content, /镜子破解了母亲/);
});

test("revert back INTO the run un-folds it (module active again, span reaches newest row)", () => {
  const rows = [row(1), row(12), row(15)]; // everything after m15 was reverted away
  const result = foldClosedRuns(rows, closedMemories(10, 30), [dungeon], new Set(["wb-happy-home"]));
  assert.equal(result.foldedMessageCount, 0);
  assert.equal(result.rows.length, 3);
});

test("a NEW attempt does not unfold the previous one", () => {
  // old run 10..30 closed; re-opened at 40 and playing (module active), rows exist past toAt
  const rows = [row(12), row(20), row(45), row(50)];
  const result = foldClosedRuns(rows, closedMemories(10, 30), [dungeon], new Set(["wb-happy-home"]));
  assert.equal(result.foldedMessageCount, 2);
  assert.equal(result.rows[0]!.content.includes("副本记忆"), true);
  assert.equal(result.rows[1]!.content, "m45");
});

test("turning runScoped off stops folding without touching records", () => {
  const result = foldClosedRuns([row(12)], closedMemories(10, 30), [{ ...dungeon, runScoped: false }], new Set());
  assert.equal(result.foldedMessageCount, 0);
});

test("a span that matches no rows injects nothing", () => {
  const result = foldClosedRuns([row(40), row(50)], closedMemories(10, 30), [dungeon], new Set());
  assert.equal(result.foldedMessageCount, 0);
  assert.equal(result.rows.length, 2);
  assert.ok(!result.rows.some((r) => r.content.includes("副本记忆")));
});

// ── memory subscriptions ──

const hub: Worldbook = {
  id: "wb-hub",
  name: "主城",
  activation: { mode: "always" },
  order: 2,
  memorySubscriptions: [{ sourceBookId: "wb-happy-home" }],
};

function readyMemories(): RunMemories {
  return {
    closed: [
      { bookId: "wb-happy-home", runIndex: 1, fromAt: at(10), toAt: at(30), closedAt: at(30), summaryStatus: "ready", summary: "第一次团灭于母亲。" },
      { bookId: "wb-happy-home", runIndex: 2, fromAt: at(40), toAt: at(60), closedAt: at(60), summaryStatus: "ready", summary: "第二次用镜子通关。" },
      { bookId: "wb-happy-home", runIndex: 3, fromAt: at(70), toAt: at(90), closedAt: at(90), summaryStatus: "pending" },
    ],
  };
}

test("an active subscriber receives only READY summaries, in one block", () => {
  const blocks = buildContextInputBlocks({ worldbooks: [dungeon, hub], activeBookIds: new Set(["wb-hub"]), memories: readyMemories(), alreadyInHistory: new Set(), rows: [], state: state("hub") });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.content, /过往经历 · 「副本：幸福之家」/);
  assert.match(blocks[0]!.content, /第1次: 第一次团灭于母亲。/);
  assert.match(blocks[0]!.content, /第2次: 第二次用镜子通关。/);
  assert.ok(!blocks[0]!.content.includes("第3次"));
});

test("an inactive subscriber receives nothing", () => {
  const blocks = buildContextInputBlocks({ worldbooks: [dungeon, hub], activeBookIds: new Set(), memories: readyMemories(), alreadyInHistory: new Set(), rows: [], state: state("hub") });
  assert.equal(blocks.length, 0);
});

test("lore mode gets the archive framing; limit trims to the most recent", () => {
  const loreHub: Worldbook = { ...hub, id: "wb-rumors", memorySubscriptions: [{ sourceBookId: "wb-happy-home", as: "lore", limit: 1 }] };
  const blocks = buildContextInputBlocks({ worldbooks: [dungeon, loreHub], activeBookIds: new Set(["wb-rumors"]), memories: readyMemories(), alreadyInHistory: new Set(), rows: [], state: state("hub") });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.content, /档案记录/);
  assert.ok(!blocks[0]!.content.includes("第1次"));
  assert.match(blocks[0]!.content, /第2次/);
});

test("a run whose fold block already sits in the history is not repeated", () => {
  const memories = readyMemories();
  const inHistory = new Set([memories.closed![1]!]);
  const blocks = buildContextInputBlocks({ worldbooks: [dungeon, hub], activeBookIds: new Set(["wb-hub"]), memories, alreadyInHistory: inHistory, rows: [], state: state("hub") });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.content, /第1次/);
  assert.ok(!blocks[0]!.content.includes("第2次"));
});

test("two active subscribers to the same source+mode merge into one block; self/unknown sources are skipped", () => {
  const hub2: Worldbook = { ...hub, id: "wb-hub2" };
  const selfSub: Worldbook = { ...hub, id: "wb-selfish", memorySubscriptions: [{ sourceBookId: "wb-selfish" }, { sourceBookId: "wb-ghost" }] };
  const blocks = buildContextInputBlocks({
    worldbooks: [dungeon, hub, hub2, selfSub],
    activeBookIds: new Set(["wb-hub", "wb-hub2", "wb-selfish"]),
    memories: readyMemories(),
    alreadyInHistory: new Set(),
    rows: [],
    state: state("hub"),
  });
  assert.equal(blocks.length, 1);
});

// ── summary attachment ──

test("attachRunSummary matches by identity and flips status; missing record returns null", () => {
  const memories = closedMemories(10, 30);
  const target = { bookId: "wb-happy-home", runIndex: 1, fromAt: at(10) };
  const ok = attachRunSummary(memories, target, "总结文本");
  assert.equal(ok!.closed![0]!.summary, "总结文本");
  assert.equal(ok!.closed![0]!.summaryStatus, "ready");

  const failed = attachRunSummary(memories, target, null);
  assert.equal(failed!.closed![0]!.summaryStatus, "failed");

  const gone = attachRunSummary({ closed: [] }, target, "x");
  assert.equal(gone, null);
});

test("formatRunMemoryBlock labels failed runs without a fake summary", () => {
  const rec = closedMemories(10, 30).closed![0]!;
  rec.summaryStatus = "failed";
  const text = formatRunMemoryBlock(rec, "副本：幸福之家");
  assert.match(text, /已封存/);
  assert.ok(!text.includes("整理中"));
});


// ── station inputs beyond memory ──

const chronicler: Worldbook = {
  id: "wb-chronicler",
  name: "史官",
  activation: { mode: "always" },
  order: 5,
  station: { kind: "worker", task: "把上一轮写成三行" },
};

/** A dungeon that drinks the chronicler's write-ups. */
const secondRun: Worldbook = {
  id: "wb-second",
  name: "副本二",
  activation: { mode: "always" },
  order: 6,
  station: { kind: "narrator", inputs: [{ kind: "worker", from: "wb-chronicler" }] },
};

const withWorkerOutput = (): RunMemories => ({
  workers: [
    { bookId: "wb-chronicler", index: 1, at: at(31), status: "ready", text: "他在母亲面前失手了。" },
    { bookId: "wb-chronicler", index: 2, at: at(61), status: "pending" },
  ],
});

test("a worker input carries the worker's READY output and skips pending ones", () => {
  const blocks = buildContextInputBlocks({
    worldbooks: [chronicler, secondRun],
    activeBookIds: new Set(["wb-second"]),
    memories: withWorkerOutput(),
    alreadyInHistory: new Set(),
    rows: [],
    state: state("x"),
  });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.content, /史官/);
  assert.match(blocks[0]!.content, /他在母亲面前失手了。/);
});

test("a worker with nothing ready yet injects no empty block", () => {
  const blocks = buildContextInputBlocks({
    worldbooks: [chronicler, secondRun],
    activeBookIds: new Set(["wb-second"]),
    memories: { workers: [{ bookId: "wb-chronicler", index: 1, at: at(31), status: "pending" }] },
    alreadyInHistory: new Set(),
    rows: [],
    state: state("x"),
  });
  assert.equal(blocks.length, 0);
});

test("a variables input renders the source module's variables by name", () => {
  const reader: Worldbook = {
    id: "wb-reader",
    name: "读表的",
    activation: { mode: "always" },
    order: 7,
    station: { kind: "narrator", inputs: [{ kind: "variables", from: "wb-happy-home" }] },
  };
  const blocks = buildContextInputBlocks({
    worldbooks: [dungeon, reader],
    activeBookIds: new Set(["wb-reader"]),
    memories: null,
    alreadyInHistory: new Set(),
    rows: [],
    variables: [
      { id: "deaths", name: "死亡次数", type: "number", defaultValue: 0, worldbookId: "wb-happy-home" },
      { id: "gold", name: "金币", type: "number", defaultValue: 0 },
    ] as never,
    state: { variables: { deaths: 3, gold: 99 }, turnCount: 0 } as unknown as GameState,
  });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.content, /死亡次数: 3/);
  // Core variables belong to Core, not to the module that was asked for.
  assert.ok(!blocks[0]!.content.includes("金币"));
});

test("a transcript input takes the tail of the source module's own spans only", () => {
  const eavesdropper: Worldbook = {
    id: "wb-ears",
    name: "偷听者",
    activation: { mode: "always" },
    order: 8,
    station: { kind: "narrator", inputs: [{ kind: "transcript", from: "wb-happy-home", limit: 2 }] },
  };
  const blocks = buildContextInputBlocks({
    worldbooks: [dungeon, eavesdropper],
    activeBookIds: new Set(["wb-ears"]),
    memories: { closed: [{ bookId: "wb-happy-home", runIndex: 1, fromAt: at(10), toAt: at(30), closedAt: at(30), summaryStatus: "ready", summary: "s" }] },
    alreadyInHistory: new Set(),
    // Rows at 5 and 40 fall OUTSIDE the run; only 20 and 25 are the module's.
    rows: [row(5, "user", "开局"), row(20, "user", "推门"), row(25, "assistant", "门开了"), row(40, "user", "回城")],
    state: state("x"),
  });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.content, /推门/);
  assert.match(blocks[0]!.content, /门开了/);
  assert.ok(!blocks[0]!.content.includes("开局"));
  assert.ok(!blocks[0]!.content.includes("回城"));
});

test("a plain content module draws nothing even while active", () => {
  // The back-compat line, restated where it can actually be violated: a module
  // with no station never pulls context, whatever else is on the card.
  const blocks = buildContextInputBlocks({
    worldbooks: [dungeon, plainBook, chronicler],
    activeBookIds: new Set(["wb-plain", "wb-chronicler"]),
    memories: withWorkerOutput(),
    alreadyInHistory: new Set(),
    rows: [],
    state: state("x"),
  });
  assert.equal(blocks.length, 0);
});


// ── the leak that a playthrough found ──

test("a worker's reading material never reaches the player's turn", () => {
  // The chronicler is always-active and reads the dungeon's RAW transcript.
  // Emitting every active station's wires put that transcript into the
  // player-facing prompt, which handed back verbatim the run the card had
  // just archived — the wipe, undone by the module that was supposed to
  // summarise it. Only the narrator's own wires belong in this prompt.
  const chronicler: Worldbook = {
    id: "wb-chr",
    name: "史官",
    activation: { mode: "always" },
    order: 5,
    station: {
      kind: "worker",
      task: "写三行",
      inputs: [{ kind: "transcript", from: "wb-happy-home", limit: 12 }],
    },
  };
  const town: Worldbook = {
    id: "wb-town",
    name: "副本二",
    activation: { mode: "always" },
    order: 6,
    station: { kind: "narrator", inputs: [{ kind: "worker", from: "wb-chr" }] },
  };
  const scoped: Worldbook = { ...dungeon, id: "wb-happy-home" };

  const blocks = buildContextInputBlocks({
    worldbooks: [scoped, chronicler, town],
    activeBookIds: new Set(["wb-chr", "wb-town"]),
    memories: {
      closed: [{ bookId: "wb-happy-home", runIndex: 1, fromAt: at(10), toAt: at(30), closedAt: at(30), summaryStatus: "ready", summary: "s" }],
      workers: [{ bookId: "wb-chr", index: 1, at: at(31), status: "ready", text: "三行简报" }],
    },
    alreadyInHistory: new Set(),
    rows: [row(20, "user", "副本里的原话")],
    state: state("x"),
  });

  const text = blocks.map((b) => b.content).join("\n");
  assert.match(text, /三行简报/);
  assert.ok(!text.includes("副本里的原话"), "the worker's transcript wire leaked into the player's prompt");
});

test("with no narrator station, no wires are drawn at all", () => {
  // Every card in the library is this one.
  const blocks = buildContextInputBlocks({
    worldbooks: [dungeon, plainBook],
    activeBookIds: new Set(["wb-plain", "wb-happy-home"]),
    memories: readyMemories(),
    alreadyInHistory: new Set(),
    rows: [],
    state: state("happy-home"),
  });
  assert.equal(blocks.length, 0);
});

// ── own memory ──
//
// The tower: a module whose AI remembers only what was said inside it. The
// messages never leave the transcript; the town narrator still sees them
// afterwards. Only the tower window is narrow.

const tower: Worldbook = {
  id: "wb-tower",
  name: "副本：迷雾塔",
  activation: { mode: "conditions", conditions: [{ variableId: "active-dungeon-id", operator: "eq", value: "tower" }], conditionLogic: "all" },
  station: { kind: "narrator", onClose: "keep", history: "own" },
  order: 0,
};
const town: Worldbook = {
  id: "wb-town",
  name: "主世界",
  activation: { mode: "always" },
  order: 1,
};

test("a keep-on-close module with its own memory is run-tracked; without it, it is not", () => {
  const t = detectRunTransitions([tower, town], state(""), state("tower"));
  assert.deepEqual(t.opened, ["wb-tower"]);
  const plainKeep: Worldbook = { ...tower, id: "wb-keep", station: { kind: "narrator", onClose: "keep" } };
  const none = detectRunTransitions([plainKeep, town], state(""), state("tower"));
  assert.deepEqual(none.opened, []);
});

test("scopeRowsToOwnRuns keeps the open run and every closed run, and nothing between them", () => {
  const memories: RunMemories = {
    closed: [{ bookId: "wb-tower", runIndex: 1, fromAt: at(10), toAt: at(20), closedAt: at(20), summaryStatus: "pending" }],
    open: { "wb-tower": { fromAt: at(40), runIndex: 2 } },
  };
  const rows = [row(5), row(12), row(18), row(25), row(30), row(42), row(50)];
  const kept = scopeRowsToOwnRuns(rows, memories, "wb-tower").map((r) => r.content);
  assert.deepEqual(kept, ["m12", "m18", "m42", "m50"]);
});

test("scopeRowsToOwnRuns with no recorded run sees nothing — the first turn of a fresh run", () => {
  assert.deepEqual(scopeRowsToOwnRuns([row(5), row(12)], null, "wb-tower"), []);
  assert.deepEqual(scopeRowsToOwnRuns([row(5)], { open: { "wb-other": { fromAt: at(1), runIndex: 1 } } }, "wb-tower"), []);
});

test("promptHistory: inside the tower the AI has never heard of the town; back in town it remembers the tower", () => {
  const rows = [row(5, "user", "town-1"), row(6, "assistant", "town-2"), row(12, "user", "tower-1"), row(13, "assistant", "tower-2"), row(30, "user", "town-3")];
  const memories: RunMemories = {
    closed: [{ bookId: "wb-tower", runIndex: 1, fromAt: at(12), toAt: at(13), closedAt: at(13), summaryStatus: "pending" }],
  };
  const inside = promptHistory(rows, { ...memories, open: { "wb-tower": { fromAt: at(40), runIndex: 2 } } }, [tower, town], new Set(["wb-tower", "wb-town"]));
  assert.deepEqual(inside.rows.map((r) => r.content), ["tower-1", "tower-2"]);
  assert.equal(inside.foldedRunCount, 0, "keep-on-close: nothing is folded away, not even its own past");
  const outside = promptHistory(rows, memories, [tower, town], new Set(["wb-town"]));
  assert.deepEqual(outside.rows.map((r) => r.content), ["town-1", "town-2", "tower-1", "tower-2", "town-3"]);
});

test("promptHistory leaves a shared-memory narrator exactly where foldClosedRuns left it", () => {
  const rows = [row(5), row(12), row(35)];
  const memories = closedMemories(10, 30);
  const viaFold = foldClosedRuns(rows, memories, [dungeon, plainBook], new Set());
  const viaPrompt = promptHistory(rows, memories, [dungeon, plainBook], new Set());
  assert.deepEqual(viaPrompt.rows.map((r) => r.content), viaFold.rows.map((r) => r.content));
});
