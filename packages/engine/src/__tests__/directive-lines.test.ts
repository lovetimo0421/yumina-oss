import { describe, it, expect } from "vitest";
import { ResponseParser } from "../parser/response-parser.js";
import { cleanDisplayText } from "../parser/display-text.js";
import { classifyBracketSpan, findBracketLines } from "../parser/directive-lines.js";
import { createMockVariable, createMockWorld } from "./test-utils.js";

// Leftover shapes seen in prod play (stored replies, 24h): the scanners did not
// accept them, so they stayed in the story. Each must be hidden; each is
// applied when it can be recovered into valid writes on real variables.
const world = createMockWorld({
  variables: [
    createMockVariable({ id: "location", name: "Location", type: "string", defaultValue: "" }),
    createMockVariable({ id: "mood", name: "Mood", type: "string", defaultValue: "" }),
    createMockVariable({ id: "memory", name: "Memory", type: "string", defaultValue: "" }),
    createMockVariable({ id: "log", name: "Log", type: "string", defaultValue: "" }),
    createMockVariable({ id: "app_places", name: "Places", type: "string", defaultValue: "" }),
    createMockVariable({ id: "exhaustion", name: "Exhaustion", type: "number", defaultValue: 0 }),
    createMockVariable({ id: "intimacy", name: "Intimacy", type: "number", defaultValue: 0 }),
    createMockVariable({ id: "hp", name: "HP", type: "number", defaultValue: 10 }),
    createMockVariable({ id: "locked", name: "Locked", type: "number", defaultValue: 0, aiAccess: "read" }),
    createMockVariable({ id: "npcs", name: "NPCs", type: "json", defaultValue: {} }),
    createMockVariable({ id: "player", name: "Player", type: "json", defaultValue: { status: "" } }),
    createMockVariable({ id: "events", name: "Events", type: "json", defaultValue: {} }),
    createMockVariable({ id: "min_jun", name: "Min-jun", type: "json", defaultValue: {} }),
    createMockVariable({ id: "rules", name: "Rules", type: "json", defaultValue: [] }),
    createMockVariable({ id: "met", name: "Met", type: "boolean", defaultValue: false }),
  ],
});

const parser = new ResponseParser();
const parse = (text: string) => parser.parse(text, undefined, { world });
const STORY = "她把门关上了。";

describe("bracket-line bookkeeping: recovered and applied", () => {
  it("[variableId: game-state.location: set …] (Gemini 3.1 Flash Lite)", () => {
    const r = parse(`${STORY}\n[variableId: game-state.location: set "客厅"]`);
    expect(r.effects).toEqual([{ variableId: "location", operation: "set", value: "客厅" }]);
    expect(r.cleanText).toBe(STORY);
    expect(r.unapplied).toBeUndefined();
  });

  it("[variable: mood: set …] (Gemini 3 Flash)", () => {
    const r = parse(`${STORY}\n[variable: mood: set "angry"]`);
    expect(r.effects).toEqual([{ variableId: "mood", operation: "set", value: "angry" }]);
    expect(r.cleanText).toBe(STORY);
  });

  it("[state: {json}] sets each key that is a variable; reports the rest", () => {
    const r = parse(`${STORY}\n[state: {"location": "Hyunjin_studio", "mood": "total_immersion", "activity": "sensory_overload"}]`);
    expect(r.effects).toEqual([
      { variableId: "location", operation: "set", value: "Hyunjin_studio" },
      { variableId: "mood", operation: "set", value: "total_immersion" },
    ]);
    expect(r.cleanText).toBe(STORY);
    expect(r.unapplied).toHaveLength(1);
    expect(r.unapplied![0]!.targets).toEqual(["location", "mood"]);
  });

  it("[state: set {json}, append {json}] applies each op per key", () => {
    const r = parse(`${STORY}\n[state: set {"exhaustion": 90, "intimacy": 100}, append {"memory": "Office chair incident"}]`);
    expect(r.effects).toEqual([
      { variableId: "exhaustion", operation: "set", value: 90 },
      { variableId: "intimacy", operation: "set", value: 100 },
      { variableId: "memory", operation: "append", value: "Office chair incident" },
    ]);
    expect(r.cleanText).toBe(STORY);
    expect(r.unapplied).toBeUndefined();
  });

  it("comma-chained ops and key-value continuations become separate writes", () => {
    const r = parse(`${STORY}\n[log: append ", Scene: The Polaroid Amnesty", "npcs.s_coups.treasured_memory": 120]`);
    expect(r.effects).toEqual([
      { variableId: "log", operation: "append", value: ", Scene: The Polaroid Amnesty" },
      { variableId: "npcs.s_coups.treasured_memory", operation: "set", value: 120 },
    ]);
    expect(r.cleanText).toBe(STORY);
  });

  it("two appends on one dot-path", () => {
    const r = parse(`${STORY}\n[player.status: append ", Marked", append ", Heat Cycle started"]`);
    expect(r.effects).toEqual([
      { variableId: "player.status", operation: "append", value: ", Marked" },
      { variableId: "player.status", operation: "append", value: ", Heat Cycle started" },
    ]);
    expect(r.cleanText).toBe(STORY);
  });
});

describe("more leftover shapes from the 24h prod sample", () => {
  it("[id | value] with a pipe, only when the key is a variable", () => {
    const r = parse(`${STORY}\n[mood | Protective/Terrified]\n[hp | +5]`);
    expect(r.effects).toEqual([
      { variableId: "mood", operation: "set", value: "Protective/Terrified" },
      { variableId: "hp", operation: "add", value: 5 },
    ]);
    expect(r.cleanText).toBe(STORY);
    const bar = "[状态|二楼房门口|00:25]";
    expect(parse(`${STORY}\n${bar}`).cleanText).toBe(`${STORY}\n${bar}`);
  });

  it("no colon: [id op value] and [id.path.op value] on a variable", () => {
    const r = parse(`${STORY}\n[log append " · confession"]\n[npcs.ana.notes.push "late"]`);
    expect(r.effects).toEqual([
      { variableId: "log", operation: "append", value: " · confession" },
      { variableId: "npcs.ana.notes", operation: "push", value: "late" },
    ]);
    expect(r.cleanText).toBe(STORY);
  });

  it("an unknown prefix in front of a real directive", () => {
    const r = parse(`${STORY}\n[_s: mood: set "雨"]`);
    expect(r.effects).toEqual([{ variableId: "mood", operation: "set", value: "雨" }]);
    expect(r.cleanText).toBe(STORY);
  });

  it("echoed prompt block names and no-change notes go without a report", () => {
    const r = parse(`${STORY}\n[game-state]\n[/directive-format]\n[state-reminder]\n[No state changes this turn.]`);
    expect(r.cleanText).toBe(STORY);
    expect(r.unapplied).toBeUndefined();
  });

  it("a bare JSON Patch array applies like <UpdateVariable>", () => {
    const r = parse(`${STORY}\n[{"op":"replace","path":"/location","value":"bridge"},{"op":"delta","path":"/hp","value":-2}]`);
    expect(r.effects).toEqual([
      { variableId: "location", operation: "set", value: "bridge" },
      { variableId: "hp", operation: "subtract", value: 2 },
    ]);
    expect(r.cleanText).toBe(STORY);
  });

  it("placeholder-rooted paths, dot-path deltas and echoed block names", () => {
    const r = parse(`${STORY}\n[game-state.seventeen.Woozi: {"mood": "realistic"}]\n[relationships.Lia.affinity：+5]\n[variable_updates]\n[variables]\n[]`);
    expect(r.cleanText).toBe(STORY);
    // The first two were attempts (reported), the rest carry nothing.
    expect(r.unapplied?.map((u) => u.text)).toEqual(['[game-state.seventeen.Woozi: {"mood": "realistic"}]', "[relationships.Lia.affinity：+5]"]);
    // `mood` there is a field of seventeen.Woozi, not the world's `mood`.
    expect(r.unapplied?.[0]?.targets).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("an operation word followed by a comma still marks bookkeeping", () => {
    const r = parse(`${STORY}\n[memory: append, "楼下的最后交锋"]`);
    expect(r.cleanText).toBe(STORY);
    expect(r.unapplied?.[0]?.targets).toEqual(["memory"]);
  });
});

describe("bracket-line bookkeeping: hidden, not applied, reported", () => {
  it.each([
    ['[events: set "Patient_Discharged" true]', ["events"]],
    ['[app_places: set here "manor_courtyard"]', ["app_places"]],
    ['[min_jun: status "vanished from memory"]', ["min_jun"]],
    ['[rules: update 4 {"text": "No running"}]', ["rules"]],
    ['[location: set Sunagakure - Training Ground 12 "The Crucible"]', ["location"]],
    ['[state: {"hp": "lots"}]', ["hp"]],
    ['[state: {"locked": 5}]', ["locked"]],
  ])("%s", (line, targets) => {
    const r = parse(`${STORY}\n${line}`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([]);
    expect(r.unapplied).toEqual([{ text: line, targets }]);
  });

  it("hides several bookkeeping spans on one line, keeps the story above", () => {
    const r = parse(`第一段。\n\n第二段。\n[events: set "X" true] [rules: update 1 {}]`);
    expect(r.cleanText).toBe("第一段。\n\n第二段。");
    expect(r.unapplied).toHaveLength(2);
  });

  it("without a world: placeholder keys and operation words still hide, nothing applies", () => {
    const r = parser.parse(`${STORY}\n[state: {"location": "x"}]\n[foo: set "a" true]`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([]);
    expect(r.unapplied?.map((u) => u.text)).toEqual(['[state: {"location": "x"}]', '[foo: set "a" true]']);
  });
});

describe("bracket lines that stay", () => {
  it.each([
    "[Day 3: Morning]",
    "[时间：清晨]",
    "[第三章]",
    "[Chapter One: Begin]",
    "[Mission complete]",
  ])("card display line %s", (line) => {
    const r = parse(`${STORY}\n${line}`);
    expect(r.cleanText).toBe(`${STORY}\n${line}`);
    expect(r.unapplied).toBeUndefined();
  });

  it("keeps platform tags and drops only the bookkeeping span next to them", () => {
    const r = parse(`${STORY}\n[image: /cdn/key/abc123|alt=门] [state: {"mood": "calm"}]`);
    expect(r.cleanText).toBe(`${STORY}\n[image: /cdn/key/abc123|alt=门]`);
    expect(r.effects).toEqual([{ variableId: "mood", operation: "set", value: "calm" }]);
  });

  it("keeps [bg: id] for the background resolver when the world has backgrounds and no bg variable", () => {
    const withBg = createMockWorld({
      variables: world.variables,
      backgrounds: [{ id: "forest_dawn", name: "Forest", url: "https://x.test/f.png", scene: "dawn in the forest" }],
    });
    const r = parser.parse(`${STORY}\n[bg: forest_dawn]`, undefined, { world: withBg });
    expect(r.cleanText).toBe(`${STORY}\n[bg: forest_dawn]`);
    expect(r.effects).toEqual([]);
  });

  it("keeps a speaker line and a video embed", () => {
    expect(classifyBracketSpan("[speaker: Mia]")).toBe("platform");
    const r = parse(`${STORY}\n[video: /cdn/key/clip9]`);
    expect(r.cleanText).toBe(`${STORY}\n[video: /cdn/key/clip9]`);
  });

  it("an operation the standard pattern does not take is reported, not set as a value", () => {
    const r = parse(`${STORY} [rules: update 1 {}]`);
    expect(r.effects).toEqual([]);
    expect(r.cleanText).toBe(STORY);
    expect(r.unapplied).toEqual([{ text: "[rules: update 1 {}]", targets: ["rules"] }]);
  });

  it("leaves brackets inside a prose line alone unless the scanners accepted them", () => {
    const text = '他在墙上写下 [state: {"x": 1}] 然后走了。';
    expect(parse(text).cleanText).toBe(text);
  });

  it("leaves a line a card's reply rule is waiting for", () => {
    const ruled = createMockWorld({
      variables: world.variables,
      replyRules: [{ id: "r1", match: { pattern: "\\[STATUS:[^\\]]*\\]" }, to: [{ kind: "event" }] }],
    });
    const r = parser.parse(`${STORY}\n[STATUS: set "hp" 5]`, undefined, { world: ruled });
    expect(r.cleanText).toBe(`${STORY}\n[STATUS: set "hp" 5]`);
  });

  it("a real variable named like a placeholder is a variable, not a placeholder", () => {
    const own = createMockWorld({ variables: [createMockVariable({ id: "state", name: "State", type: "string", defaultValue: "" })] });
    const r = parser.parse("Ok.\n[state: set calm]", undefined, { world: own });
    expect(r.effects).toEqual([{ variableId: "state", operation: "set", value: "calm" }]);
    expect(r.cleanText).toBe("Ok.");
  });
});

describe("findBracketLines", () => {
  it("only lines made entirely of balanced bracket spans", () => {
    const text = 'a [x: 1]\n[y: {"k": [1, 2]}] [z: 2]\n  [w: set "]"]\n[open: 1';
    expect(findBracketLines(text).map((l) => l.spans.map((s) => s.text))).toEqual([
      ['[y: {"k": [1, 2]}]', "[z: 2]"],
      ['[w: set "]"]'],
    ]);
  });
});

describe("cleanDisplayText (chat bubble, streaming and stored)", () => {
  const ids = world.variables.map((v) => v.id);

  it("hides the same leftovers with the variable ids from game state", () => {
    expect(cleanDisplayText(`${STORY}\n[events: set "X" true]`, { variableIds: ids })).toBe(STORY);
    expect(cleanDisplayText(`${STORY}\n[min_jun: status "gone"]`, { variableIds: ids })).toBe(STORY);
    // Without ids only the generic criteria apply: no op word, unknown key.
    expect(cleanDisplayText(`${STORY}\n[min_jun: "gone" forever]`)).toBe(`${STORY}\n[min_jun: "gone" forever]`);
    expect(cleanDisplayText(`${STORY}\n[min_jun: "gone" forever]`, { variableIds: ids })).toBe(STORY);
  });

  it("holds back what is still arriving while streaming", () => {
    expect(cleanDisplayText(`${STORY}\n[sta`, { streaming: true })).toBe(STORY);
    expect(cleanDisplayText(`${STORY}\n[variable: mood: se`, { streaming: true })).toBe(STORY);
    expect(cleanDisplayText(`${STORY}<rati`, { streaming: true })).toBe(STORY);
    expect(cleanDisplayText(`${STORY}\n[image: dawn_gate]`, { streaming: true })).toBe(STORY);
  });

  it("keeps the leading speaker tag when asked", () => {
    expect(cleanDisplayText("[speaker: Mia] Hi. [hp: -1]", { keepSpeakerTag: true })).toBe("[speaker: Mia]\nHi.");
    expect(cleanDisplayText("[spea", { keepSpeakerTag: true, streaming: true })).toBe("[spea");
  });

  it("keeps card display lines and images", () => {
    const text = `${STORY}\n[Day 3: Morning]\n[image: /cdn/key/abc]`;
    expect(cleanDisplayText(text, { variableIds: ids })).toBe(text);
  });
});

describe("fences emptied by the cleanup", () => {
  const w = createMockWorld({ variables: [createMockVariable({ id: "heart", name: "Heart", type: "number", defaultValue: 25 })] });

  it("drops a fence left holding only whitespace, any language tag or none", () => {
    for (const fence of ["```json", "```", "~~~ json"]) {
      const close = fence.startsWith("~") ? "~~~" : "```";
      const r = parser.parse(`T.\n\n${fence}\n[{"op":"replace","path":"/heart","value":50}]\n${close}`, undefined, { world: w });
      expect(r.effects, fence).toEqual([{ variableId: "heart", operation: "set", value: 50 }]);
      expect(r.cleanText, fence).toBe("T.");
    }
  });

  it("leaves fences that still have content, and never pairs two neighbours as one", () => {
    const text = "T.\n\n```js\nconst x = 1;\n```\n\n```\n[heart: +1]\n```\n\n```py\nprint(1)\n```";
    const r = parser.parse(text, undefined, { world: w });
    expect(r.effects).toEqual([{ variableId: "heart", operation: "add", value: 1 }]);
    expect(r.cleanText).toBe("T.\n\n```js\nconst x = 1;\n```\n\n```py\nprint(1)\n```");
  });
});

// Review of the recovery: a continuation means the same as the standalone
// directive (`heart: +5` adds, it does not set 5), and a comma list the
// standard pattern used to swallow whole is split one write per part.
describe("comma continuations keep standalone semantics", () => {
  const w = createMockWorld({
    variables: [
      createMockVariable({ id: "heart", name: "Heart", type: "number", defaultValue: 25 }),
      createMockVariable({ id: "pride", name: "Pride", type: "number", defaultValue: 10 }),
      createMockVariable({ id: "mood", name: "Mood", type: "string", defaultValue: "" }),
      createMockVariable({ id: "log", name: "Log", type: "string", defaultValue: "" }),
      createMockVariable({ id: "secrets", name: "Secrets", type: "json", defaultValue: [] }),
      createMockVariable({ id: "npcs", name: "NPCs", type: "json", defaultValue: { a: { trust: 1 } } }),
    ],
  });
  const p = (text: string) => parser.parse(`Ok.\n${text}`, undefined, { world: w });

  it.each([
    ['[secrets: push "cabinet", heart: +5]', [
      { variableId: "secrets", operation: "push", value: "cabinet" },
      { variableId: "heart", operation: "add", value: 5 },
    ]],
    ['[mood: set "soft", heart: +2]', [
      { variableId: "mood", operation: "set", value: "soft" },
      { variableId: "heart", operation: "add", value: 2 },
    ]],
    ['[variable: npcs.a.trust +5, mood: set "elated", log: append ", x"]', [
      { variableId: "npcs.a.trust", operation: "add", value: 5 },
      { variableId: "mood", operation: "set", value: "elated" },
      { variableId: "log", operation: "append", value: ", x" },
    ]],
    ["[heart: -3, pride: -4]", [
      { variableId: "heart", operation: "subtract", value: 3 },
      { variableId: "pride", operation: "subtract", value: 4 },
    ]],
    ["[heart: *2, pride: 7]", [
      { variableId: "heart", operation: "multiply", value: 2 },
      { variableId: "pride", operation: "set", value: 7 },
    ]],
    ["[heart: set 3, pride: add 1]", [
      { variableId: "heart", operation: "set", value: 3 },
      { variableId: "pride", operation: "add", value: 1 },
    ]],
  ])("%s", (line, expected) => {
    const r = p(line);
    expect(r.effects).toEqual(expected);
    expect(r.cleanText).toBe("Ok.");
    expect(r.unapplied).toBeUndefined();
  });

  it("splits a chained list inside a prose line too", () => {
    const r = parser.parse("She smiles. [heart: -3, pride: -4] Then leaves.", undefined, { world: w });
    expect(r.effects).toEqual([
      { variableId: "heart", operation: "subtract", value: 3 },
      { variableId: "pride", operation: "subtract", value: 4 },
    ]);
    expect(r.cleanText).toBe("She smiles. Then leaves.");
  });

  it("type checks: arithmetic on a text variable or a non-number on a number is unapplied", () => {
    const delta = p('[secrets: push "a", mood: +5]');
    expect(delta.effects).toEqual([{ variableId: "secrets", operation: "push", value: "a" }]);
    expect(delta.unapplied?.[0]?.targets).toEqual(expect.arrayContaining(["mood"]));
    const quoted = p('[mood: set "x", heart: "lots"]');
    expect(quoted.effects).toEqual([{ variableId: "mood", operation: "set", value: "x" }]);
    expect(quoted.unapplied).toHaveLength(1);
    for (const line of ["[mood: +5]", "[heart: set high]", "[log: add 3]"]) {
      const r = p(line);
      expect(r.effects, line).toEqual([]);
      expect(r.cleanText, line).toBe("Ok.");
      expect(r.unapplied, line).toHaveLength(1);
    }
  });

  it("without the world a chained list is hidden and reported, never applied as one garbage write", () => {
    const r = parser.parse("Ok. [heart: -3, pride: -4]");
    expect(r.effects).toEqual([]);
    expect(r.cleanText).toBe("Ok.");
    expect(r.unapplied?.map((u) => u.text)).toEqual(["[heart: -3, pride: -4]"]);
  });

  it.each([
    ["[heart: +5]", [{ variableId: "heart", operation: "add", value: 5 }]],
    ["[heart | 30]", [{ variableId: "heart", operation: "set", value: 30 }]],
    ["[variable: heart: -2]", [{ variableId: "heart", operation: "subtract", value: 2 }]],
    ["[npcs.a.trust: +5]", [{ variableId: "npcs.a.trust", operation: "add", value: 5 }]],
    ['[log: append ", a", append ", b"]', [
      { variableId: "log", operation: "append", value: ", a" },
      { variableId: "log", operation: "append", value: ", b" },
    ]],
    ['[state: set {"heart": 40}, append {"log": ", y"}]', [
      { variableId: "heart", operation: "set", value: 40 },
      { variableId: "log", operation: "append", value: ", y" },
    ]],
  ])("standalone %s is unchanged", (line, expected) => {
    const r = p(line);
    expect(r.effects).toEqual(expected);
    expect(r.cleanText).toBe("Ok.");
  });
});

describe("display cleanup carries authored reply-rule protection", () => {
  it.each(['[STATUS: set "hp" 5]', '[mood | calm]'])("preserves %s after server parsing, stored or streaming", (block) => {
    const raw = `Story.\n${block}`;
    const w = createMockWorld({ variables: [createMockVariable({ id: "mood", type: "string" })], replyRules: [
      { id: "display", match: { pattern: "\\[(?:STATUS:|mood \\|)[^\\]]*\\]" }, hide: false },
    ] });
    const stored = parser.parse(raw, undefined, { world: w }).cleanText;
    expect(stored).toBe(raw);
    for (const streaming of [false, true]) {
      expect(cleanDisplayText(stored, { variableIds: ["mood"], replyRules: w.replyRules, streaming })).toBe(stored);
    }
  });

  it("disabled or hidden rules do not preserve bookkeeping", () => {
    const raw = "Story.\n[mood | calm]";
    for (const flags of [{ enabled: false }, { hide: true }]) {
      expect(cleanDisplayText(raw, { variableIds: ["mood"], replyRules: [
        { id: "display", match: { pattern: "\\[mood \\|[^\\]]*\\]" }, ...flags },
      ] })).toBe("Story.");
    }
  });

  it("preserving one display block does not reveal unrelated directives", () => {
    const replyRules = [{ id: "display", match: { pattern: "\\[mood \\|[^\\]]*\\]" } }];
    expect(cleanDisplayText('Story.\n[mood | calm]\n[hp: -1]\n[state: {"unknown": 1}]', { variableIds: ["mood", "hp"], replyRules }))
      .toBe("Story.\n[mood | calm]");
  });
});
