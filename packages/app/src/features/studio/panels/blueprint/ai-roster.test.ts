import { strict as assert } from "node:assert";
import { test } from "node:test";
import { blockId, type WorldDefinition, type Worldbook } from "@yumina/engine";
import { aiFrameLine, aiReceives, aiRoster, cardTakenOverBy, placeGivesTo, shadowedBy, workerReaders } from "./ai-roster";
import { aiTableSections } from "./ai-table";

const t = (key: string, opts?: Record<string, unknown>) => {
  const args = Object.entries(opts ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
  return args ? `${key}(${args})` : key;
};
const book = (id: string, name: string, station?: Worldbook["station"]): Worldbook =>
  ({ id, name, order: 0, activation: { mode: "always" }, ...(station ? { station } : {}) }) as Worldbook;
const entry = (id: string, name: string, worldbookId?: string, alwaysSend = true) =>
  ({ id, name, content: "x", role: "lore", alwaysSend, enabled: true, keywords: [], conditions: [], conditionLogic: "all", position: 0, section: "system-presets", ...(worldbookId ? { worldbookId } : {}) });
const world = (worldbooks: Worldbook[], entries: unknown[] = [], variables: unknown[] = []) =>
  ({ entries, variables, worldbooks }) as unknown as WorldDefinition;

// 《酒馆夜话》: the narrator in the hall, the innkeeper in the backyard, a
// recorder behind the scenes writing for the innkeeper.
const tavern = () => world(
  [
    book("hall", "大堂"),
    book("yard", "老板娘", { kind: "narrator", inputs: [{ kind: "worker", from: "notes" }] }),
    book("notes", "记录员", { kind: "worker", trigger: { on: "turns", every: 3 }, task: "压成三行" }),
  ],
  [entry("world", "世界观"), entry("rules", "酒馆规矩", undefined, false), entry("bar", "吧台", "hall"), entry("ledger", "账本藏在井里", "yard")],
  [{ id: "trust", name: "信任度", type: "number", defaultValue: 30 }],
);

test("a card with one AI is the narrator alone, and its places give to nobody new", () => {
  const roster = aiRoster(world([book("hall", "大堂")]), t);
  assert.deepEqual(roster.map((a) => a.key), ["card"]);
});

test("an AI frame receives the card, the places and what other AIs write for it", () => {
  const w = tavern();
  const yard = w.worldbooks!.find((b) => b.id === "yard")!;
  const chips = aiReceives(w, yard, t);
  assert.deepEqual(chips.map((c) => c.key), ["card", "places", "in:worker:notes"]);
  assert.deepEqual(chips[0]!.sources, [blockId.frame(null)]);
  assert.deepEqual(chips[1]!.sources, [blockId.frame("hall")]);
  assert.match(chips[1]!.detail!, /大堂/);
  assert.equal(chips[2]!.label, "记录员");
});

test("one behind the scenes says when it runs and who reads it; wired to nothing, it warns", () => {
  const w = tavern();
  const notes = w.worldbooks!.find((b) => b.id === "notes")!;
  const line = aiFrameLine(w, notes, "", t);
  assert.match(line.line, /blueprint.roster.voice.behind/);
  assert.match(line.line, /wakeTurns\(n=3\)/);
  assert.match(line.gives!, /老板娘/);
  assert.deepEqual(aiReceives(w, notes, t).map((c) => c.key), ["nothing"]);
  assert.equal(aiReceives(w, notes, t)[0]!.warn, true);
});

test("a place gives to every AI that talks to the player", () => {
  assert.match(placeGivesTo(aiRoster(tavern(), t), t), /blueprint.roster.narrator.*老板娘/);
});

test("the AI table keeps a secret with its owner and a place's entries with whoever is there", () => {
  const { ais, sections } = aiTableSections(tavern(), t);
  assert.deepEqual(ais.map((a) => a.key), ["card", "book:yard", "book:notes"]);
  const lore = sections.find((s) => s.key === "lore")!;
  const row = (id: string) => lore.rows.find((r) => r.id === `entry:${id}`)!.cells.map((c) => c.tone);
  assert.deepEqual(row("world"), ["yes", "yes", "no"]);
  assert.deepEqual(row("rules"), ["cond", "cond", "no"], "keyword entries are known when mentioned");
  assert.deepEqual(row("bar"), ["cond", "cond", "no"], "a place's entry, while the player is there");
  assert.deepEqual(row("ledger"), ["no", "own", "no"], "only the innkeeper knows where the ledger is");
  const writing = sections.find((s) => s.key === "writing")!;
  assert.deepEqual(writing.rows[0]!.cells.map((c) => c.tone), ["no", "own", "own"]);
});

test("one that speaks when it goes quiet reads no wires, so nobody writes for it", () => {
  const w = world([
    book("hall", "大堂"),
    book("cat", "店猫", { kind: "worker", trigger: { on: "quiet", seconds: 60 }, task: "冷场时喵一声", inputs: [{ kind: "worker", from: "notes" }] }),
    book("notes", "记录员", { kind: "worker", trigger: { on: "turns", every: 3 }, task: "压成三行" }),
  ]);
  const cat = w.worldbooks!.find((b) => b.id === "cat")!;
  assert.deepEqual(aiReceives(w, cat, t).map((c) => c.key), ["recent"]);
  assert.deepEqual(workerReaders(w.worldbooks!, "notes"), []);
  const notes = w.worldbooks!.find((b) => b.id === "notes")!;
  assert.equal(aiFrameLine(w, notes, "", t).givesWarn, true, "what it writes reaches nobody");
});

test("an AI with no job says it will not act", () => {
  const w = world([book("cat", "店猫", { kind: "worker", trigger: { on: "quiet", seconds: 60 } })]);
  const line = aiFrameLine(w, w.worldbooks![0]!, "", t);
  assert.equal(line.gives, "blueprint.aiFrame.noTask");
  assert.equal(line.givesWarn, true);
});

test("an AI that is always there replies for the narrator, and one after it in order never gets a turn", () => {
  const always = { ...book("a", "沈霏", { kind: "narrator" }), order: 1 } as Worldbook;
  const later = { ...book("b", "店长", { kind: "narrator" }), order: 2, activation: { mode: "keywords", keywords: ["柜台"], exclusive: true } } as Worldbook;
  const w = world([book("hall", "大堂"), always, later]);
  assert.equal(cardTakenOverBy(w.worldbooks!)?.id, "a");
  assert.equal(shadowedBy(w.worldbooks!, later)?.id, "a");
  assert.equal(shadowedBy(w.worldbooks!, always), undefined);
  const line = aiFrameLine(w, later, "", t);
  assert.equal(line.gives, "blueprint.aiFrame.shadowed(name=沈霏)");
  assert.equal(line.givesWarn, true);
  assert.equal(cardTakenOverBy(world([book("hall", "大堂"), later]).worldbooks!), undefined, "one that comes in on words takes no turn from the narrator elsewhere");
});

test("the AI table leaves unplaced things out and shows a value behind the scenes to whoever talks", () => {
  const w = world(
    [book("yard", "老板娘", { kind: "narrator" }), book("notes", "记录员", { kind: "worker", trigger: { on: "turns", every: 3 }, task: "x", inputs: [{ kind: "variables", from: "core" }] })],
    [entry("loose", "没放好的", "unplaced")],
    [
      { id: "trust", name: "信任度", type: "number", defaultValue: 30 },
      { id: "mood", name: "心情", type: "number", defaultValue: 0, worldbookId: "notes" },
      { id: "stray", name: "没放好", type: "number", defaultValue: 0, worldbookId: "unplaced" },
    ],
  );
  const { sections } = aiTableSections(w, t);
  assert.equal(sections.find((s) => s.key === "lore"), undefined);
  const vars = sections.find((s) => s.key === "vars")!;
  assert.deepEqual(vars.rows.map((r) => r.id), ["var:trust", "var:mood"]);
  const row = (id: string) => vars.rows.find((r) => r.id === `var:${id}`)!.cells.map((c) => c.tone);
  assert.deepEqual(row("trust"), ["yes", "yes", "yes"], "the recorder is wired to the card's values");
  assert.deepEqual(row("mood"), ["yes", "yes", "no"], "a frame behind the scenes that is always in shows its values to whoever talks");
});
