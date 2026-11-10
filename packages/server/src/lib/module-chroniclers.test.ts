import test from "node:test";
import assert from "node:assert/strict";
import { ANY_MODULE, type GameState, type WorldDefinition, type Worldbook } from "@yumina/engine";
import { dueWorkers } from "./worker-station.js";
import { buildInputBlocksFor, type RunMemories, type RunRecord, type WorkerOutput } from "./run-scopes.js";

/**
 * 多史馆 — twenty-two dungeons, a record kept for each, and records that can
 * read each other.
 *
 * Per-dungeon chroniclers already worked one module at a time; what did not
 * exist was saying "whoever just closed" and "all of them" in one wire. These
 * pin the count (a worker that fires twice as often is a bill, not a bug
 * report) and the isolation (a chronicler must not read its own output back).
 */

const world = (books: Worldbook[]): WorldDefinition =>
  ({ name: "w", entries: [], variables: [], worldbooks: books }) as unknown as WorldDefinition;
const state = (): GameState => ({ variables: {}, turnCount: 0 }) as unknown as GameState;

const dungeon = (n: number): Worldbook => ({
  id: `d${n}`,
  name: `副本${n}`,
  activation: { mode: "always" },
  order: n,
  station: { kind: "narrator", onClose: "archive", memoryPool: `pool-d${n}` },
});

const anyChronicler = (id: string, inputs: unknown[] = []): Worldbook => ({
  id,
  name: `史官${id}`,
  activation: { mode: "always" },
  order: 500,
  station: {
    kind: "worker",
    task: "记录刚结束的那个副本",
    trigger: { on: "module-closed", from: ANY_MODULE },
    inputs: inputs as never,
  },
});

const closed = (bookId: string, runIndex = 1): RunRecord => ({
  bookId,
  runIndex,
  fromAt: "2026-01-01T00:00:00.000Z",
  toAt: "2026-01-01T00:30:00.000Z",
  closedAt: "2026-01-01T00:30:00.000Z",
  summaryStatus: "ready",
  summary: `${bookId}的经过`,
});

const output = (bookId: string, text: string): WorkerOutput =>
  ({ bookId, index: 1, at: "2026-01-01T00:31:00.000Z", status: "ready", text, cause: "module-closed" });

test("one chronicler serves every dungeon: it wakes for whoever closed, and cause names them", () => {
  const books: Worldbook[] = [];
  for (let n = 1; n <= 22; n++) books.push(dungeon(n));
  books.push(anyChronicler("chr"));
  const w = world(books);

  for (const n of [1, 13, 22]) {
    const fired = dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed(`d${n}`)] });
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0]!.cause, { on: "module-closed", bookId: `d${n}`, runIndex: 1 });
  }
});

test("two dungeons closing in one turn are two write-ups, not one", () => {
  const w = world([dungeon(1), dungeon(2), anyChronicler("chr")]);
  const fired = dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed("d1"), closed("d2")] });
  assert.deepEqual(
    fired.map((f) => (f.cause as { bookId: string }).bookId),
    ["d1", "d2"],
  );
});

test("nothing closed, nothing runs — the wildcard is not 'every turn'", () => {
  const w = world([dungeon(1), anyChronicler("chr")]);
  assert.equal(dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [] }).length, 0);
});

test("a wildcard worker is not woken by its own record", () => {
  // Only reachable if a worker ever archives, but the guard is cheap and the
  // failure it prevents is a worker triggering itself forever.
  const w = world([dungeon(1), anyChronicler("chr")]);
  const fired = dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed("chr")] });
  assert.equal(fired.length, 0);
});

test("the head archivist reads every dungeon's archive in one wire, each line named", () => {
  const head = anyChronicler("head", [{ kind: "memory", from: ANY_MODULE, as: "lore" }]);
  const books = [dungeon(1), dungeon(2), head];
  const memories = { open: {}, closed: [closed("d1"), closed("d2")], workers: [] } as unknown as RunMemories;
  const blocks = buildInputBlocksFor(head, {
    worldbooks: books,
    activeBookIds: new Set(books.map((b) => b.id)),
    memories,
    alreadyInHistory: new Set(),
    rows: [],
    state: { variables: {} } as unknown as GameState,
  });
  const text = blocks.map((b) => b.content).join("\n");
  assert.match(text, /「副本1」第1次: d1的经过/);
  assert.match(text, /「副本2」第1次: d2的经过/);
});

test("'every other worker' excludes the reader itself", () => {
  const a = anyChronicler("a");
  const head = anyChronicler("head", [{ kind: "worker", from: ANY_MODULE, as: "lore" }]);
  const books = [dungeon(1), a, head];
  const memories = {
    open: {},
    closed: [],
    workers: [output("a", "史官a写的：玩家失去了左眼"), output("head", "总史官写的：不该被自己读到")],
  } as unknown as RunMemories;
  const blocks = buildInputBlocksFor(head, {
    worldbooks: books,
    activeBookIds: new Set(books.map((b) => b.id)),
    memories,
    alreadyInHistory: new Set(),
    rows: [],
    state: { variables: {} } as unknown as GameState,
  });
  const text = blocks.map((b) => b.content).join("\n");
  assert.match(text, /失去了左眼/);
  assert.ok(!text.includes("不该被自己读到"), `总史官读到了自己的产出:\n${text}`);
});

test("a chronicler wired to nobody reads nothing — 只能看自己的 stays that way", () => {
  const a = anyChronicler("a");
  const b = anyChronicler("b");
  const books = [dungeon(1), a, b];
  const memories = { open: {}, closed: [closed("d1")], workers: [output("a", "史官a的记录")] } as unknown as RunMemories;
  const blocks = buildInputBlocksFor(b, {
    worldbooks: books,
    activeBookIds: new Set(books.map((b2) => b2.id)),
    memories,
    alreadyInHistory: new Set(),
    rows: [],
    state: { variables: {} } as unknown as GameState,
  });
  assert.deepEqual(blocks, []);
});

test("a recorder wired to the card itself reads the conversation's latest messages", () => {
  const recorder: Worldbook = {
    id: "rec",
    name: "rec",
    activation: { mode: "always" },
    order: 600,
    station: { kind: "worker", task: "summarise", trigger: { on: "turns", every: 3 }, inputs: [{ kind: "transcript", from: "core", limit: 2 }] },
  };
  const rows = [
    { id: "1", role: "user", content: "first", createdAt: new Date(1) },
    { id: "2", role: "assistant", content: "second", createdAt: new Date(2) },
    { id: "3", role: "user", content: "third", createdAt: new Date(3) },
  ];
  const blocks = buildInputBlocksFor(recorder, {
    worldbooks: [recorder],
    activeBookIds: new Set(["rec"]),
    memories: { open: {}, closed: [], workers: [] } as unknown as RunMemories,
    alreadyInHistory: new Set(),
    rows: rows as never,
    state: { variables: {} } as unknown as GameState,
  });
  const text = blocks.map((b) => b.content).join("\n");
  assert.doesNotMatch(text, /first/, "only the last `limit` messages");
  assert.match(text, /second/);
  assert.match(text, /third/);
});

test("a narrator wired to the card's conversation reads nothing more: it has the conversation already", () => {
  const narrator: Worldbook = {
    id: "upstairs",
    name: "upstairs",
    activation: { mode: "always" },
    order: 600,
    station: { kind: "narrator", inputs: [{ kind: "transcript", from: "core", limit: 2 }] },
  };
  const blocks = buildInputBlocksFor(narrator, {
    worldbooks: [narrator],
    activeBookIds: new Set(["upstairs"]),
    memories: { open: {}, closed: [], workers: [] } as unknown as RunMemories,
    alreadyInHistory: new Set(),
    rows: [{ id: "1", role: "user", content: "archived line", createdAt: new Date(1) }] as never,
    state: { variables: {} } as unknown as GameState,
  });
  assert.deepEqual(blocks, []);
});
