import assert from "node:assert/strict";
import test from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { aiTypeOf, entryReadBy, livesSomewhere, placeAis } from "./place-ais";

const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}${JSON.stringify(opts)}` : key);
const world = {
  name: "旧书店",
  settings: {},
  entries: [],
  worldbooks: [
    { id: "attic", name: "阁楼", order: 1, activation: { mode: "keywords", keywords: ["阁楼"] } },
    { id: "cat", name: "店猫", order: 0, host: "card", activation: { mode: "always" }, station: { kind: "narrator", memoryPool: "pool-cat", onClose: "keep" } },
    { id: "guide", name: "引路人", order: 1, host: "attic", activation: { mode: "always" }, station: { kind: "narrator", inputs: [{ kind: "worker", from: "diary" }] } },
    { id: "diary", name: "战地日记", order: 2, host: "attic", activation: { mode: "always" }, station: { kind: "worker", trigger: { on: "turns", every: 3 }, task: "记", inputs: [{ kind: "transcript", from: "core", limit: 20 }] } },
    { id: "loose", name: "新的 AI", order: 3, host: "unplaced", activation: { mode: "always" }, station: { kind: "narrator" } },
  ],
} as unknown as WorldDefinition;

test("the card: its own AI, then the AIs that live on the card — a group chat; one put nowhere is shown off", () => {
  const card = placeAis(world, undefined, t);
  assert.deepEqual(card.rows.map((r) => r.name), ["blueprint.placeAis.defaultName", "店猫", "新的 AI"]);
  assert.deepEqual(card.rows.map((r) => r.type), ["turn", "turn", "turn"]);
  assert.equal(card.rows[2]!.off, true);
  assert.equal(card.group, true, "the one put nowhere does not answer");
  assert.match(card.rows[1]!.memory, /memOwn/);
});

test("the three types, by what calls the AI", () => {
  assert.equal(aiTypeOf({ kind: "narrator" }), "turn");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "turns", every: 3 } }), "turn");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "after", from: "x" } }), "turn");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "ui" } }), "ui");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "conditions", conditions: [] } }), "event");
  assert.equal(aiTypeOf({ kind: "worker", trigger: { on: "quiet", seconds: 60 } }), "event");
});

test("a situation with an AI of its own: the narrator steps aside, the writer hands on", () => {
  const attic = placeAis(world, "attic", t);
  assert.deepEqual(attic.rows.map((r) => r.key), ["narrator", "guide", "diary"]);
  assert.equal(attic.rows[0]!.away, true);
  assert.equal(attic.group, false);
  assert.match(attic.rows[1]!.link ?? "", /linkReceives.*战地日记/);
  assert.match(attic.rows[2]!.link ?? "", /linkWrites.*引路人/);
  assert.match(attic.rows[2]!.job, /jobEveryTurns/);
});

test("keeping the narrator makes it a group chat", () => {
  const kept = { ...world, worldbooks: world.worldbooks!.map((b) => (b.id === "attic" ? { ...b, narratorHere: true } : b)) };
  const attic = placeAis(kept, "attic", t);
  assert.equal(attic.rows[0]!.away, undefined);
  assert.equal(attic.group, true);
});

test("no AI is a frame: every one is a row; a scenario is still a scenario", () => {
  const books = world.worldbooks!;
  assert.deepEqual(books.filter(livesSomewhere).map((b) => b.id), ["cat", "guide", "diary", "loose"]);
});

test("an AI call written in the interface code is a row: on the card every call, in a situation the calls that read it", () => {
  const coded = {
    ...world,
    rootComponent: {
      id: "r", name: "Stage", entryFile: "index.tsx", updatedAt: "",
      files: {
        "index.tsx": "export default function App(){ return React.createElement(Chat); }",
        "director.ts": "await api.ai.complete({ messages, context:'session', includeLorebook:'matched', worldbookIds:['attic'], responseFormat:{type:'json_object'} });\nawait api.ai.decide({ questions });",
      },
    },
  } as unknown as WorldDefinition;
  const card = placeAis(coded, undefined, t);
  const code = card.rows.filter((r) => r.code);
  assert.deepEqual(code.map((r) => r.key), ["code:director.ts:1", "code:director.ts:2"]);
  assert.deepEqual(code.map((r) => r.type), ["script", "script"]);
  assert.equal(code[0]!.name, "阁楼", "named for the situation it reads");
  assert.match(code[0]!.link!, /linkReadsModules/);
  assert.match(code[0]!.memory, /memLoreMatched/);
  assert.match(code[1]!.name, /codeCallName/, "a call that names no situation is named for its file");
  assert.equal(card.group, true, "code calls never count as voices");

  const attic = placeAis(coded, "attic", t);
  assert.deepEqual(attic.rows.filter((r) => r.code).map((r) => r.key), ["code:director.ts:1"]);
  assert.match(attic.rows.find((r) => r.code)!.job, /jobFromCodeHere/);
  assert.equal(placeAis(coded, "cat", t).rows.some((r) => r.code), false);
});

test("calls on one line of a compiled bundle get keys of their own, the same on the card and in a situation", () => {
  const coded = {
    ...world,
    rootComponent: {
      id: "r", name: "Stage", entryFile: "index.js", updatedAt: "",
      files: { "index.js": "a.ai.complete({messages});b.ai.decide({questions});c.ai.complete({worldbookIds:['attic']});" },
    },
  } as unknown as WorldDefinition;
  const keys = placeAis(coded, undefined, t).rows.filter((r) => r.code).map((r) => r.key);
  assert.deepEqual(keys, ["code:index.js:1", "code:index.js:1#2", "code:index.js:1#3"]);
  assert.deepEqual(placeAis(coded, "attic", t).rows.filter((r) => r.code).map((r) => r.key), ["code:index.js:1#3"]);
});

test("a custom AI is a declared slot: implemented by the code call that reads it, or not yet", () => {
  const coded = {
    ...world,
    worldbooks: [
      ...(world.worldbooks ?? []),
      { id: "still-estragon", name: "Estragon", order: 9, host: "card", activation: { mode: "always" }, station: { kind: "custom" } },
      { id: "warden", name: "Warden", order: 10, host: "card", activation: { mode: "always" }, station: { kind: "custom" } },
    ],
    rootComponent: {
      id: "r", name: "Stage", entryFile: "index.tsx", updatedAt: "",
      files: { "use-still.ts": "await api.ai.complete({ messages, includeLorebook: 'matched', worldbookIds: [`still-${who}`] });" },
    },
  } as unknown as WorldDefinition;
  const card = placeAis(coded, undefined, t);
  const estragon = card.rows.find((r) => r.bookId === "still-estragon")!;
  assert.equal(estragon.type, "custom");
  assert.match(estragon.job, /jobImplemented/);
  assert.equal(estragon.code?.file, "use-still.ts");
  const warden = card.rows.find((r) => r.bookId === "warden")!;
  assert.match(warden.job, /jobUnimplemented/);
  assert.equal(card.rows.filter((r) => r.key.startsWith("code:")).length, 0, "the implementing call is the AI's row, not a second row");
  assert.equal(aiTypeOf({ kind: "custom" }), "custom");
});

test("two code calls reading the same situations are told apart by where they are", async () => {
  const { codeCallRows } = await import("./place-ais");
  const w = {
    id: "w", name: "w", entries: [], variables: [],
    worldbooks: [{ id: "a", name: "Estragon", order: 0, activation: { mode: "always" } }],
    rootComponent: { id: "r", name: "r", entryFile: "index.tsx", updatedAt: "", files: { "index.tsx": 'await api.ai.complete({ worldbookIds: ["a"] });\nawait api.ai.complete({ worldbookIds: ["a"] });' } },
  } as never;
  const names = codeCallRows(w, undefined, (k: string) => k).map((r) => r.name);
  assert.equal(new Set(names).size, names.length, names.join(" | "));
});

test("an interface that never sends into the chat never wakes the story AI; a live voice is an AI of its own", async () => {
  const { placeAis: rowsOf, storyAiIsCalled } = await import("./place-ais");
  const voiced = {
    ...world,
    rootComponent: { id: "r", name: "Room", entryFile: "index.tsx", updatedAt: "", files: { "index.tsx": "const v = api.realtimeVoice;\nawait v.start({ instructions });\nsetInterval(tick, 1000);" } },
  } as unknown as WorldDefinition;
  assert.equal(storyAiIsCalled(voiced), false);
  const card = rowsOf(voiced, undefined, t);
  assert.equal(card.rows.some((r) => r.key === "narrator"), false, "a story AI nothing calls is not on the board");
  const room = { ...voiced, worldbooks: [{ id: "room", name: "Room", order: 1, activation: { mode: "always" } }] } as unknown as WorldDefinition;
  assert.equal(rowsOf(room, "room", t).rows.some((r) => r.key === "narrator"), false, "nor inside a situation");
  const voice = card.rows.find((r) => r.key.startsWith("voice:"));
  assert.deepEqual(voice?.codeAt, { file: "index.tsx", line: 1 }, "it opens the code where the voice is");
  const chatty = { ...voiced, rootComponent: { ...voiced.rootComponent!, files: { "index.tsx": "return <MessageInput />;" } } } as WorldDefinition;
  assert.equal(storyAiIsCalled(chatty), true, "the stock chat components send into the chat");
  assert.equal(storyAiIsCalled(world), true, "no interface of its own: the stock chat");
});

test("two calls in one file with no situation say the file once, then the line", () => {
  const coded = {
    ...world,
    rootComponent: {
      id: "r", name: "Stage", entryFile: "phone.tsx", updatedAt: "",
      files: { "phone.tsx": "await api.ai.complete({ messages });\n\nawait api.ai.complete({ messages });" },
    },
  } as unknown as WorldDefinition;
  const names = placeAis(coded, undefined, t).rows.filter((r) => r.code).map((r) => r.name);
  const bare = t("blueprint.placeAis.codeCallName", { file: "phone.tsx" });
  assert.deepEqual(names, [`${bare}:1`, `${bare}:3`]);
});

test("a code AI with a note is called what the note calls it", () => {
  const coded = {
    ...world,
    rootComponent: { id: "r", name: "Stage", entryFile: "a.tsx", updatedAt: "", files: { "a.tsx": "await api.ai.complete({ messages });\nawait api.ai.complete({ messages });" } },
    graphLayout: { version: 5, nodes: {}, notes: [
      { id: "n1", x: 0, y: 0, w: 200, h: 44, text: "Rival bidder: plays whoever the player talks to.", targets: ["ai:code:a.tsx:1"] },
      { id: "n2", x: 0, y: 0, w: 200, h: 44, text: "Just one plain sentence about it.", targets: ["ai:code:a.tsx:2"] },
    ] },
  } as unknown as WorldDefinition;
  const names = placeAis(coded, undefined, t).rows.filter((r) => r.code).map((r) => r.name);
  assert.equal(names[0], "Rival bidder");
  assert.match(names[1]!, /codeCallName/, "a note with no lead leaves the name alone");
});

test("a game page that declares its own AIs shows them, and its chat AI is not called", () => {
  const pvz = {
    ...world,
    worldbooks: [],
    rootComponent: { id: "r", name: "Stage", entryFile: "index.tsx", updatedAt: "", files: { "index.tsx": "export default function App(){ return React.createElement(Chat); }" } },
    game: { path: "/pvz/", ais: [{ name: "Crazy Dave", gets: "the lawn", returns: "a line and a favour", where: "server/lib/game-npc" }] },
  } as unknown as WorldDefinition;
  const rows = placeAis(pvz, undefined, t).rows;
  const dave = rows.find((r) => r.type === "game")!;
  assert.equal(dave.key, "game:0");
  assert.equal(dave.name, "Crazy Dave");
  assert.deepEqual(dave.game, { gets: "the lawn", returns: "a line and a favour", where: "server/lib/game-npc" });
  assert.equal(rows.some((r) => r.key === "narrator"), false, "the chat's own AI never speaks on a game page, so it is not on the board");
  // Without declared AIs a game page is as before.
  const plain = { ...pvz, game: { path: "/pvz/" } } as unknown as WorldDefinition;
  assert.equal(placeAis(plain, undefined, t).rows.some((r) => r.type === "game"), false);
  assert.notEqual(placeAis(plain, undefined, t).rows[0]!.away, true);
});

test("a situation the game reads is spoken by that game AI, not the chat's", () => {
  const pvz = {
    ...world,
    worldbooks: [{ id: "dave", name: "Crazy Dave", order: 1, enabled: false, activation: { mode: "always" } }],
    game: { path: "/pvz/", ais: [{ name: "Crazy Dave", book: "dave" }, { name: "Zen Garden plants" }] },
  } as unknown as WorldDefinition;
  const rows = placeAis(pvz, "dave", t).rows;
  assert.deepEqual(rows.map((r) => r.name), ["Crazy Dave"]);
  assert.equal(rows[0]!.type, "game");
});

test("the fallback a screen takes when calling one of its AIs fails is that AI, not a row of its own", () => {
  const coded = {
    ...world,
    worldbooks: [...world.worldbooks!, { id: "ref", name: "Referee", order: 5, host: "card", activation: { mode: "always" }, station: { kind: "worker", name: "Referee", trigger: { on: "ui" }, answer: "json" } }],
    rootComponent: { id: "r", name: "Stage", entryFile: "a.tsx", updatedAt: "", files: { "a.tsx": "let r = await api.callAi('Referee', input);\nif (!r) r = await api.ai.complete({ messages });" } },
  } as unknown as WorldDefinition;
  const rows = placeAis(coded, undefined, t).rows;
  assert.equal(rows.some((r) => r.code), false, "no second Referee row from the code");
  assert.equal(rows.find((r) => r.bookId === "ref")!.returns, "→ JSON");
});

test("an entry says who reads it when the chat is not where it goes", () => {
  const pvz = {
    ...world,
    worldbooks: [{ id: "dave", name: "Crazy Dave", order: 1, enabled: false, activation: { mode: "manual" } }],
    game: { path: "/pvz/", ais: [{ name: "Crazy Dave", book: "dave" }] },
  } as unknown as WorldDefinition;
  assert.equal(entryReadBy(pvz, "dave"), "game");
  const screen = {
    ...world,
    worldbooks: [{ id: "official", name: "Official", order: 1, activation: { mode: "always" } }, { id: "ref", name: "Referee", order: 2, activation: { mode: "always" }, station: { kind: "worker", trigger: { on: "ui" } } }],
    rootComponent: { id: "r", name: "Stage", entryFile: "index.tsx", updatedAt: "", files: { "index.tsx": "const lore = api.entries; voice.start({ lore });" } },
  } as unknown as WorldDefinition;
  assert.equal(entryReadBy(screen, "official"), "interface", "plain lore on a card whose chat never speaks: the code reads it");
  assert.equal(entryReadBy(screen, "ref"), null, "an AI's own entries are that AI's");
  assert.equal(entryReadBy(world, undefined), null, "a card with a chat: the chat's AI, as usual");
});
