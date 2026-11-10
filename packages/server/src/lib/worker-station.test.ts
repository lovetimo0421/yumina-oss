import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, WorldDefinition, Worldbook } from "@yumina/engine";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { dueWorkers, finishSlot, loadRowsForInputs, reserveSlot } from "./worker-station.js";
import type { RunMemories, RunRecord } from "./run-scopes.js";

/**
 * Trigger evaluation is where a background AI silently never runs, or silently
 * runs every turn and bills for it. Both are invisible from the product, so
 * they are pinned here.
 */

const dungeon: Worldbook = {
  id: "wb-d1",
  name: "副本一",
  activation: { mode: "always" },
  order: 0,
  station: { kind: "narrator" },
};

const chronicler = (over: Partial<Worldbook> = {}): Worldbook => ({
  id: "wb-chr",
  name: "史官",
  activation: { mode: "always" },
  order: 1,
  station: { kind: "worker", task: "写三行", trigger: { on: "module-closed", from: "wb-d1" } },
  ...over,
});

const world = (books: Worldbook[]): WorldDefinition =>
  ({ name: "w", entries: [], variables: [], worldbooks: books }) as unknown as WorldDefinition;

const state = (vars: Record<string, unknown> = {}, turnCount = 0): GameState =>
  ({ variables: vars, turnCount }) as unknown as GameState;

const closed = (bookId: string): RunRecord => ({
  bookId,
  runIndex: 2,
  fromAt: "2026-01-01T00:00:00.000Z",
  toAt: "2026-01-01T00:30:00.000Z",
  closedAt: "2026-01-01T00:30:00.000Z",
  summaryStatus: "pending",
});

test("a module-closed worker wakes when its source closes, and only then", () => {
  const w = world([dungeon, chronicler()]);
  const fired = dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed("wb-d1")] });
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.book.id, "wb-chr");
  assert.deepEqual(fired[0]!.cause, { on: "module-closed", bookId: "wb-d1", runIndex: 2 });

  const quiet = dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [] });
  assert.equal(quiet.length, 0);
});

test("a different module closing does not wake it", () => {
  const w = world([dungeon, chronicler()]);
  const fired = dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed("wb-other")] });
  assert.equal(fired.length, 0);
});

test("a narrator is never woken as a worker", () => {
  // The whole card is stations; only the background ones run in the background.
  const w = world([dungeon]);
  assert.equal(dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed("wb-d1")] }).length, 0);
});

test("a plain content module is never woken", () => {
  const plain: Worldbook = { id: "wb-lore", name: "设定", activation: { mode: "always" }, order: 2 };
  const w = world([dungeon, plain]);
  assert.equal(dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed("wb-d1")] }).length, 0);
});

test("a worker whose own activation is off stays asleep", () => {
  // Its activation rule is still the master switch — a chapter-two chronicler
  // must not write during chapter one.
  const gated = chronicler({
    activation: { mode: "conditions", conditions: [{ variableId: "chapter", operator: "eq", value: 2 }], conditionLogic: "all" },
  });
  const w = world([dungeon, gated]);
  const off = dueWorkers({ worldDef: w, prevState: state({ chapter: 1 }), nextState: state({ chapter: 1 }), closedRecords: [closed("wb-d1")] });
  assert.equal(off.length, 0);
  const on = dueWorkers({ worldDef: w, prevState: state({ chapter: 2 }), nextState: state({ chapter: 2 }), closedRecords: [closed("wb-d1")] });
  assert.equal(on.length, 1);
});

test("a worker with no trigger never fires on its own", () => {
  const w = world([dungeon, chronicler({ station: { kind: "worker", task: "写三行" } })]);
  assert.equal(dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed("wb-d1")] }).length, 0);
});

test("a conditions worker fires on the rising edge only", () => {
  const analyst = chronicler({
    id: "wb-analyst",
    station: {
      kind: "worker",
      task: "分析",
      trigger: { on: "conditions", conditions: [{ variableId: "hp", operator: "lt", value: 10 }], conditionLogic: "all" },
    },
  });
  const w = world([dungeon, analyst]);
  // false → true fires.
  assert.equal(dueWorkers({ worldDef: w, prevState: state({ hp: 50 }), nextState: state({ hp: 5 }), closedRecords: [] }).length, 1);
  // true → true is the same event continuing, not a new one. Without this,
  // a wounded player pays for an analysis every single turn.
  assert.equal(dueWorkers({ worldDef: w, prevState: state({ hp: 5 }), nextState: state({ hp: 4 }), closedRecords: [] }).length, 0);
  // true → false is not an event either.
  assert.equal(dueWorkers({ worldDef: w, prevState: state({ hp: 5 }), nextState: state({ hp: 50 }), closedRecords: [] }).length, 0);
});

test("a turns worker fires on the multiple and stays quiet between", () => {
  const w = world([
    dungeon,
    chronicler({ id: "wb-diary", station: { kind: "worker", task: "记日记", trigger: { on: "turns", every: 5 } } }),
  ]);
  const at = (turn: number) =>
    dueWorkers({ worldDef: w, prevState: state({}, turn - 1), nextState: state({}, turn), closedRecords: [], turnCount: turn }).length;
  assert.equal(at(4), 0);
  assert.equal(at(5), 1);
  assert.equal(at(6), 0);
  assert.equal(at(10), 1);
  // Turn 0 is not "every 5 turns", it is the start.
  assert.equal(at(0), 0);
});

test("an after worker wakes when the AI it follows answered, and only then", () => {
  const w = world([
    dungeon,
    chronicler({ id: "wb-echo", station: { kind: "worker", task: "接着写", trigger: { on: "after", from: "wb-d1" } } }),
  ]);
  const run = (answeredBy: string | null) =>
    dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [], answeredBy });
  const fired = run("wb-d1");
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0]!.cause, { on: "after", bookId: "wb-d1" });
  // Another AI answering, or the card's own narrator, is not its cue.
  assert.equal(run("wb-other").length, 0);
  assert.equal(run(null).length, 0);
});

test("several workers can be due from one transition", () => {
  const w = world([
    dungeon,
    chronicler(),
    chronicler({ id: "wb-chr2", name: "另一个史官" }),
  ]);
  const fired = dueWorkers({ worldDef: w, prevState: state(), nextState: state(), closedRecords: [closed("wb-d1")] });
  assert.equal(fired.length, 2);
});

test("a card with no modules asks nothing of the database", () => {
  assert.equal(dueWorkers({ worldDef: world([]), prevState: state(), nextState: state(), closedRecords: [] }).length, 0);
});

test("transcript inputs receive each source's latest bounded rows after long and unrelated runs", async () => {
  const client = new PGlite();
  const database = drizzle(client) as unknown as NonNullable<Parameters<typeof loadRowsForInputs>[4]>;
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const run = (bookId: string, from: number, to: number): RunRecord => ({
    ...closed(bookId), fromAt: at(from), toAt: at(to), closedAt: at(to),
  });
  try {
    await client.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TIMESTAMP);
      INSERT INTO messages
      SELECT 'm-' || n, 's1', 'assistant', 'm-' || n,
             TIMESTAMP '2026-01-01 00:00:00' + n * INTERVAL '1 second'
      FROM generate_series(1, 1000) n;
      INSERT INTO messages VALUES ('other-session', 's2', 'assistant', 'WRONG SESSION', '2026-01-01 00:08:25');
    `);
    const sourceB = { ...dungeon, id: "b" };
    const sourceC = { ...dungeon, id: "c" };
    const worker = chronicler({ station: { kind: "worker", inputs: [
      { kind: "transcript", from: dungeon.id, limit: 4 },
      { kind: "transcript", from: dungeon.id, limit: 2, as: "lore" },
      { kind: "transcript", from: "b", limit: 3 },
    ] } });
    const books = [dungeon, sourceB, sourceC, worker];
    const memories = { closed: [run(dungeon.id, 1, 210), run(dungeon.id, 500, 505), run("b", 700, 705), run("c", 900, 1000)] };
    const rows = await loadRowsForInputs("s1", worker, books, memories, database);
    assert.deepEqual(rows.map((row) => row.content), ["m-502", "m-503", "m-504", "m-505", "m-703", "m-704", "m-705"]);
    const beforeFuture = await loadRowsForInputs("s1", worker, books, memories, database, at(504));
    assert.deepEqual(beforeFuture.map((row) => row.content), ["m-501", "m-502", "m-503", "m-504"]);

    // An open source span is also readable, even when other modules have a
    // large backlog. Rows in the gap between source runs are never material.
    const openRows = await loadRowsForInputs("s1", worker, books, {
      closed: [run("b", 700, 705)], open: { [dungeon.id]: { fromAt: at(997), runIndex: 2 } },
    }, database);
    assert.deepEqual(openRows.map((row) => row.content), ["m-703", "m-704", "m-705", "m-997", "m-998", "m-999", "m-1000"]);
  } finally {
    await client.close();
  }
});

test("workers without live transcript sources never query history", async () => {
  const noQueries = { select: () => { throw new Error("unexpected history query"); } } as unknown as NonNullable<Parameters<typeof loadRowsForInputs>[4]>;
  assert.deepEqual(await loadRowsForInputs("s1", chronicler(), [dungeon], null, noQueries), []);
  const worker = chronicler({ station: { kind: "worker", inputs: [{ kind: "transcript", from: "missing", limit: 4 }] } });
  assert.deepEqual(await loadRowsForInputs("s1", worker, [dungeon, worker], { closed: [closed(dungeon.id)] }, noQueries), []);
});

test("a rewind prevents delayed worker reservation and completion from entering the new timeline", async () => {
  const client = new PGlite();
  const database = drizzle(client) as unknown as NonNullable<Parameters<typeof reserveSlot>[4]>;
  const read = async () => (await client.query<{ run_memories: RunMemories }>("SELECT run_memories FROM play_sessions WHERE id = 's1'")).rows[0]!.run_memories;
  try {
    await client.exec(`CREATE TABLE play_sessions (id TEXT PRIMARY KEY, run_memories JSONB);
      INSERT INTO play_sessions VALUES ('s1', '{"generation":"before-revert"}');`);
    const old = await reserveSlot("s1", "worker", { on: "turns", turn: 5 }, "before-revert", database);
    assert.ok(old);
    await client.exec(`UPDATE play_sessions SET run_memories = '{"generation":"after-revert"}' WHERE id = 's1'`);

    // The old job can be delayed before it has a slot at all. A completion-only
    // guard cannot stop this second reservation from recreating deleted work.
    assert.equal(await reserveSlot("s1", "worker", { on: "turns", turn: 5 }, "before-revert", database), null);
    assert.equal((await read()).workers, undefined);
    await finishSlot("s1", old, "OLD FUTURE", database);
    assert.equal((await read()).workers, undefined);

    const fresh = await reserveSlot("s1", "worker", { on: "turns", turn: 5 }, "after-revert", database);
    assert.ok(fresh);
    await finishSlot("s1", fresh, "NEW TIMELINE", database);
    assert.equal((await read()).workers?.[0]?.text, "NEW TIMELINE");

    // Identity collisions and copied historical slots must not make an old
    // async result valid merely because the old slot's other fields match.
    await client.query("UPDATE play_sessions SET run_memories = $1 WHERE id = 's1'", [JSON.stringify({ generation: "after-revert", workers: [old] })]);
    await finishSlot("s1", old, "OLD FUTURE", database);
    assert.equal((await read()).workers?.[0]?.status, "pending");
  } finally {
    await client.close();
  }
});
