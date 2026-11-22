import { describe, it, expect } from "vitest";
import { ResponseParser } from "../parser/response-parser.js";
import { cleanDisplayText } from "../parser/display-text.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { createMockVariable, createMockWorld } from "./test-utils.js";

const ROWS5 = [
  "Aiko | trust +3 | event=walked her home",
  "Ren | trust -1 | event=skipped practice",
  "Mio | trust +2 | event=lent a pen",
  "Sora | trust +1 | event=shared lunch",
  "Kai | trust -2 | event=argued in class",
].join("\n");

const world = createMockWorld({
  variables: [
    createMockVariable({ id: "mood", name: "Mood", type: "string", defaultValue: "" }),
    createMockVariable({ id: "hp", name: "HP", type: "number", defaultValue: 10 }),
    createMockVariable({ id: "silence", name: "Silence", type: "string", defaultValue: "" }),
    createMockVariable({ id: "relationship-events", name: "Relationship events", type: "string", defaultValue: ROWS5 }),
    createMockVariable({ id: "item-events", name: "Item events", type: "string", defaultValue: "" }),
    createMockVariable({ id: "location", name: "Location", type: "string", defaultValue: "" }),
    createMockVariable({ id: "region", name: "Region", type: "string", defaultValue: "" }),
    createMockVariable({ id: "locked-events", name: "Locked events", type: "string", defaultValue: "", aiAccess: "read" }),
  ],
});

const parser = new ResponseParser();
const parse = (text: string) => parser.parse(text, undefined, { world });
const STORY = "She closed the door behind her and listened to the rain.";

describe("directive label before trailing directives (Bug A)", () => {
  it.each([
    ["Narrator states complete. Directives follow."],
    ["Directives:"],
    ["(unsigned); Directives then."],
    ["**Directives:**"],
    ["State changes:"],
  ])("drops %j once the directives after it are taken out", (label) => {
    const r = parse(`${STORY}\n\n${label}\n[mood: set "calm"]\n[hp: -1]`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([
      { variableId: "mood", operation: "set", value: "calm" },
      { variableId: "hp", operation: "subtract", value: 1 },
    ]);
  });

  it("drops a stray `\"]` remainder line together with the label", () => {
    const r = parse(`${STORY}\n\nNarrator states complete. Directives follow.\n[mood: set "calm"]\n"]`);
    expect(r.cleanText).toBe(STORY);
  });

  it("strips only the label sentence when it is glued to the last paragraph", () => {
    expect(parse(`${STORY} Directives follow.\n[mood: set "calm"]`).cleanText).toBe(STORY);
    expect(parse(`她把门关上了。Directives:\n[mood: set "calm"]`).cleanText).toBe("她把门关上了。");
  });

  it("keeps a looser label when nothing was taken out after it", () => {
    expect(parse(`${STORY}\n\nUpdates below.`).cleanText).toBe(`${STORY}\n\nUpdates below.`);
    expect(parse(`${STORY}\n\nState changes:`).cleanText).toBe(`${STORY}\n\nState changes:`);
  });

  // GLM 5.3 Flash replies that wrote the label and then no directives at all.
  it.each([
    ["d2dab372", "…tapping the deck with two fingers as a signal of absolute surrender.\n\nDirectives follow.", "…tapping the deck with two fingers as a signal of absolute surrender."],
    // A long paragraph (the real one is over 400 characters).
    ["88b441e6", `${"The wind carries no charm. ".repeat(20)}Its bolt loosely rattled loose by the wave. Directives follow.`, `${"The wind carries no charm. ".repeat(20)}Its bolt loosely rattled loose by the wave.`],
    ["0119b83f", "…and one of them quietly pulls a rope loose.\n\nDirectives follow.", "…and one of them quietly pulls a rope loose."],
    ["1fb1ba22", "…roaring through cupped hands: \"Rune Knights are two streets out!(unsigned);\n\nDirectives then.", "…roaring through cupped hands: \"Rune Knights are two streets out!"],
  ])("strict label with nothing after it (%s)", (_id, tail, kept) => {
    const r = parse(`${STORY}\n\n${tail}`);
    expect(r.cleanText).toBe(`${STORY}\n\n${kept}`);
    expect(r.effects).toEqual([]);
  });

  it("strict labels are still whole sentences only", () => {
    for (const prose of ["Her directives follow.", "The directives: ignored.", "Directives follow the old law."]) {
      expect(parse(`${STORY}\n\n${prose}`).cleanText, prose).toBe(`${STORY}\n\n${prose}`);
    }
  });

  it("keeps prose that mentions directives", () => {
    for (const prose of [
      "She read the directives twice.",
      "The directives follow her everywhere.",
      "Updates from the front were grim, and the directives below them worse.",
    ]) {
      const r = parse(`${STORY}\n\n${prose}\n[mood: set "calm"]`);
      expect(r.cleanText, prose).toBe(`${STORY}\n\n${prose}`);
    }
  });

  it("the streaming bubble hides the label before its directives arrive", () => {
    expect(cleanDisplayText(`${STORY}\n\nDirectives follow.\n[mo`, { streaming: true })).toBe(STORY);
    expect(cleanDisplayText(`${STORY}\n\nDirectives follow.`, { streaming: true })).toBe(STORY);
    expect(cleanDisplayText(`${STORY}\n\nDirectives:\n[mood: set "calm"]`, { variableIds: ["mood"] })).toBe(STORY);
    // A saved reply with nothing after it keeps a looser label.
    expect(cleanDisplayText(`${STORY}\n\nUpdates below.`)).toBe(`${STORY}\n\nUpdates below.`);
  });
});

describe("header + rows block at the end of a reply (Bug B)", () => {
  const rows = "Aiko | trust +4 | event=shared an umbrella\nRen | trust -2 | event=was ignored";

  it.each([
    ["relationship-events"],
    ["relationship-events:"],
    ["[relationship-events]"],
  ])("%s header: rows are set and hidden", (header) => {
    const r = parse(`${STORY}\n\n${header}\n${rows}`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([{ variableId: "relationship-events", operation: "set", value: rows }]);
  });

  it("reads several blocks, a None body, a label and bracket directives around them", () => {
    const r = parse(`${STORY}\n\nDirectives:\n[hp: -1]\nrelationship-events\n${rows}\nitem-events\nNone`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([
      { variableId: "hp", operation: "subtract", value: 1 },
      { variableId: "relationship-events", operation: "set", value: rows },
      { variableId: "item-events", operation: "set", value: "None" },
    ]);
  });

  it("the chat bubble hides the block with variable ids only", () => {
    const text = `${STORY}\n\nrelationship-events\n${rows}`;
    expect(cleanDisplayText(text, { variableIds: ["relationship-events"] })).toBe(STORY);
    expect(cleanDisplayText(text)).toBe(text);
  });

  it.each([
    ["an unknown id", `${STORY}\n\nromance-events\n${rows}`],
    ["a plain word with no colon (prose line)", `${STORY}\n\nsilence\nwas all she gave him.`],
    ["a different case", `${STORY}\n\nSilence:\nwas all she gave him.`],
    ["a block that is not at the end", `${STORY}\n\nrelationship-events\n${rows}\n\nThe rain went on.`],
    ["a header glued to a story line", `${STORY}\nrelationship-events\n${rows}`],
    ["a read-only variable", `${STORY}\n\nlocked-events\n${rows}`],
    ["a number variable", `${STORY}\n\nhp:\n-5`],
    ["a key: value paragraph with a prose key", `${STORY}\n\nNote: something`],
    ["a key: value paragraph with one prose line", `${STORY}\n\nlocation: Urahara Shop\nShe closed her eyes.`],
    ["a key: value line on a number variable", `${STORY}\n\nhp: 5`],
  ])("leaves %s alone", (_name, text) => {
    const r = parse(text);
    expect(r.cleanText).toBe(text);
    expect(r.effects).toEqual([]);
  });

  it("a reply made only of blocks (Bleach #323)", () => {
    const r = parse(`[relationship-events]\n${rows}\n\n[item-events]\nNone`);
    expect(r.cleanText).toBe("");
    expect(r.effects).toEqual([
      { variableId: "relationship-events", operation: "set", value: rows },
      { variableId: "item-events", operation: "set", value: "None" },
    ]);
  });

  it("inside a block a plain-word id line starts the next block (Bleach #8)", () => {
    const r = parse(`${STORY}\n\nrelationship-events\n${rows}\nlocation\nA hardware store rooftop\nitem-events\nNone`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([
      { variableId: "relationship-events", operation: "set", value: rows },
      { variableId: "location", operation: "set", value: "A hardware store rooftop" },
      { variableId: "item-events", operation: "set", value: "None" },
    ]);
  });

  it("a trailing paragraph of `id: value` lines sets each (Bleach #213)", () => {
    const r = parse(`${STORY}\n\nrelationship-events\n${rows}\n\nlocation: Urahara Shop, Karakura Town\nregion: Karakura Town`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([
      { variableId: "relationship-events", operation: "set", value: rows },
      { variableId: "location", operation: "set", value: "Urahara Shop, Karakura Town" },
      { variableId: "region", operation: "set", value: "Karakura Town" },
    ]);
  });

  it("a plain-word id still works with a colon", () => {
    const r = parse(`${STORY}\n\nsilence:\nnobody spoke`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([{ variableId: "silence", operation: "set", value: "nobody spoke" }]);
  });
});

describe("partial recovery never wipes a text variable (Bug B)", () => {
  const replacement = [
    'Aiko | trust +4 | event=she said "thanks", then smiled',
    "Ren | trust -1 | event=left early, annoyed",
    "Mio | trust +2 | event=lent a pen, again",
    'Sora | trust +1 | event=laughed at "the joke"',
    "Kai | trust -2 | event=argued, then apologised",
  ].join("\n");

  it("a multi-line set with quotes and story commas keeps all five rows", () => {
    const r = parse(`${STORY}\n[relationship-events: set ${replacement}]`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([{ variableId: "relationship-events", operation: "set", value: replacement }]);
    expect(r.unapplied).toBeUndefined();
    const state = new GameStateManager(world);
    state.applyEffects(r.effects);
    expect(String(state.get("relationship-events")).split("\n")).toHaveLength(5);
  });

  it("the same with no operation word", () => {
    const r = parse(`${STORY}\n[relationship-events: ${replacement}]`);
    expect(r.effects).toEqual([{ variableId: "relationship-events", operation: "set", value: replacement }]);
  });

  it("a partial recovery does not set the first fragment as the whole value", () => {
    const r = parse(`${STORY}\n[relationship-events: Aiko | trust +4, ghost: x]`);
    expect(r.cleanText).toBe(STORY);
    expect(r.effects).toEqual([]);
    expect(r.unapplied?.[0]?.targets).toContain("relationship-events");
    const state = new GameStateManager(world);
    state.applyEffects(r.effects);
    expect(state.get("relationship-events")).toBe(ROWS5);
  });

  it("single-line quotes stay ambiguous (unchanged)", () => {
    const r = parse(`${STORY}\n[mood: set here "garden"]`);
    expect(r.effects).toEqual([]);
    expect(r.unapplied).toHaveLength(1);
  });
});
