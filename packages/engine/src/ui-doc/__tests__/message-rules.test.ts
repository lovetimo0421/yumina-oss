import { describe, it, expect } from "vitest";
import {
  layoutMessage,
  messageRulesPrompt,
  syncMessageRulesEntry,
  sampleConversation,
  boxCss,
  textCss,
  speakerColor,
  defaultAiHint,
  MESSAGE_RULE_PRESETS,
  MESSAGE_STYLE_PRESETS,
  UI_RULES_ENTRY_ID,
  type MsgBlock,
} from "../message-rules.js";
import { compileUiDoc } from "../compile.js";
import { validateUiDoc } from "../schema.js";
import type { UiDoc, UiElement, UiMessageRule } from "../types.js";
import type { WorldEntry } from "../../types/index.js";

const rule = (id: string, over: Partial<UiMessageRule> & Pick<UiMessageRule, "match" | "show">): UiMessageRule => ({ id, name: id, ...over });

const thought = rule("thought", { match: { kind: "wrap", open: "♡", close: "♡" }, show: "reveal" });
const banner = rule("banner", { match: { kind: "wrap", open: "【", close: "】" }, show: "banner" });
const choices = rule("choices", { match: { kind: "line-prefix", prefix: "※" }, show: "choices" });
const speaker = rule("speaker", { ...MESSAGE_RULE_PRESETS["speaker-label"]! });
const broadcast = rule("broadcast", { match: { kind: "contains", text: "【广播】" }, show: "card", options: { title: "广播" } });
const meta = rule("meta", { match: { kind: "wrap", open: "<!--", close: "-->" }, show: "hide" });

const done = { role: "assistant" as const };
const live = { role: "assistant" as const, streaming: true };

/** A readable projection of a layout: one string per block. */
function sketch(blocks: MsgBlock[]): string[] {
  return blocks.map((b) => {
    const parts = (ps: Extract<MsgBlock, { kind: "text" }>["parts"]) =>
      ps.map((p) => (p.kind === "text" ? p.text : `[${p.pending ? "…" : ""}${p.ruleId}#${p.n}:${p.text}]`)).join("");
    switch (b.kind) {
      case "text": return `T:${parts(b.parts)}`;
      case "banner": return `B:${b.text}`;
      case "choices": return `C:${b.items.join("|")}`;
      case "speaker": return `S:${b.name}>${parts(b.parts)}`;
    }
  });
}

describe("layoutMessage", () => {
  it("leaves a message alone when no rule applies", () => {
    const out = layoutMessage("Hello **there**", [thought], done);
    expect(out.touched).toBe(false);
    expect(sketch(out.blocks)).toEqual(["T:Hello **there**"]);
  });

  it("covers a wrapped thought and numbers each cover per rule", () => {
    const out = layoutMessage("她笑了。♡好开心♡然后♡别说出来♡", [thought], done);
    expect(sketch(out.blocks)).toEqual(["T:她笑了。[thought#0:好开心]然后[thought#1:别说出来]"]);
    expect(out.touched).toBe(true);
  });

  it("draws a whole-line wrap as a banner, and leaves 【名字】台词 for the speaker rule", () => {
    const out = layoutMessage("【第3天·傍晚】\n雨停了。\n【艾拉】你来了。", [banner, speaker], done);
    expect(sketch(out.blocks)).toEqual(["B:第3天·傍晚", "T:雨停了。", "S:艾拉>你来了。"]);
  });

  it("groups consecutive choice lines, blank lines between them included", () => {
    const out = layoutMessage("要怎么做？\n※ 跟上去\n\n※ **先回家**\n※", [choices], done);
    expect(sketch(out.blocks)).toEqual(["T:要怎么做？", "C:跟上去|先回家"]);
  });

  it("reads 名字：台词 speaker lines and covers thoughts inside them", () => {
    const out = layoutMessage("艾拉：好啊。♡其实很开心♡\n诺亚: 嗯。", [speaker, thought], done);
    expect(sketch(out.blocks)).toEqual(["S:艾拉>好啊。[thought#0:其实很开心]", "S:诺亚>嗯。"]);
  });

  it("draws the whole message as a card and drops its marker", () => {
    const out = layoutMessage("【广播】\n今晚八点后请勿外出。", [broadcast, banner], done);
    expect(out.card).toEqual({ ruleId: "broadcast", title: "广播" });
    expect(sketch(out.blocks)).toEqual(["T:今晚八点后请勿外出。"]);
  });

  it("hides what hide rules match before any other rule sees it", () => {
    const out = layoutMessage("你好<!-- 【秘密】 -->。\n【第1天】", [meta, banner], done);
    expect(sketch(out.blocks)).toEqual(["T:你好。", "B:第1天"]);
  });

  it("lets the earlier rule win when two claim the same text", () => {
    const a = rule("a", { match: { kind: "wrap", open: "(", close: ")" }, show: "reveal" });
    const b = rule("b", { match: { kind: "contains", text: "(x)" }, show: "reveal" });
    expect(sketch(layoutMessage("1 (x) 2", [a, b], done).blocks)).toEqual(["T:1 [a#0:x] 2"]);
    expect(sketch(layoutMessage("1 (x) 2", [b, a], done).blocks)).toEqual(["T:1 [b#0:(x)] 2"]);
  });

  it("escapes regex specials in markers — they are literal text, not patterns", () => {
    const star = rule("star", { match: { kind: "wrap", open: "(*", close: "*)" }, show: "reveal" });
    expect(sketch(layoutMessage("a (*b*) c .* d", [star], done).blocks)).toEqual(["T:a [star#0:b] c .* d"]);
  });

  it("keeps model text as data: markup is never interpreted, only sorted", () => {
    const out = layoutMessage("♡<img src=x onerror=alert(1)>♡\n※ <b>go</b>", [thought, choices], done);
    expect(sketch(out.blocks)).toEqual(["T:[thought#0:<img src=x onerror=alert(1)>]", "C:<b>go</b>"]);
  });

  describe("while streaming", () => {
    it("shows an unclosed thought as a pending cover, not as prose", () => {
      expect(sketch(layoutMessage("她说。♡其实", [thought], live).blocks)).toEqual(["T:她说。[…thought#0:其实]"]);
    });

    it("keeps an unclosed wrap as written once the reply is finished", () => {
      expect(sketch(layoutMessage("她说。♡其实", [thought], done).blocks)).toEqual(["T:她说。♡其实"]);
    });

    it("holds back a banner line until it closes", () => {
      expect(sketch(layoutMessage("雨停了。\n【第3天", [banner], live).blocks)).toEqual(["T:雨停了。"]);
    });

    it("hides the first characters of a marker still arriving", () => {
      const tag = rule("tag", { match: { kind: "wrap", open: "<think>", close: "</think>" }, show: "hide" });
      expect(sketch(layoutMessage("你好<th", [tag], live).blocks)).toEqual(["T:你好"]);
      expect(sketch(layoutMessage("你好<think>内心", [tag], live).blocks)).toEqual(["T:你好"]);
      // Finished: an unclosed marker is text the model really wrote.
      expect(sketch(layoutMessage("你好<th", [tag], done).blocks)).toEqual(["T:你好<th"]);
    });

    it("holds a line that could still become a prefix marker", () => {
      const double = rule("double", { match: { kind: "line-prefix", prefix: "※※" }, show: "choices" });
      expect(sketch(layoutMessage("走吧。\n※", [double], live).blocks)).toEqual(["T:走吧。"]);
    });
  });

  it("applies to the player's own lines only when asked", () => {
    const own = { ...thought, options: { applyToUser: true } };
    expect(layoutMessage("♡x♡", [thought], { role: "user" }).touched).toBe(false);
    expect(layoutMessage("♡x♡", [own], { role: "user" }).touched).toBe(true);
    expect(layoutMessage("♡x♡", [own], { role: "system" }).touched).toBe(false);
  });

  it("skips disabled rules and patterns that do not compile", () => {
    const off = { ...thought, enabled: false };
    const broken = rule("broken", { match: { kind: "regex", pattern: "([" }, show: "hide" });
    expect(layoutMessage("♡x♡ ([", [off, broken], done).touched).toBe(false);
  });

  it("survives a regex that can match nothing", () => {
    const empty = rule("empty", { match: { kind: "regex", pattern: "x*" }, show: "hide" });
    expect(sketch(layoutMessage("abc", [empty], done).blocks)).toEqual(["T:abc"]);
  });
});

describe("paint helpers", () => {
  it("turns a box style into CSS, image fills resolved", () => {
    const css = boxCss({
      fills: [{ kind: "image", src: { kind: "asset", ref: "@asset:1" } }, { kind: "color", color: "#111" }],
      radius: [4, 8, 8, 8],
      borderColor: "#fff",
      padding: 12,
    }, (ref) => `/cdn/${ref.slice(7)}`);
    expect(css).toEqual({
      background: 'url("/cdn/1") center/cover no-repeat, #111',
      borderRadius: "4px 8px 8px 8px",
      border: "1px solid #fff",
      padding: 12,
    });
  });

  it("maps a card-loaded family to its runtime name", () => {
    expect(textCss({ family: "Cinzel", size: 15, italic: true }, { Cinzel: "Cinzel__a1" })).toEqual({ fontFamily: "Cinzel__a1", fontSize: 15, fontStyle: "italic" });
  });

  it("gives the same name the same colour", () => {
    expect(speakerColor("艾拉")).toBe(speakerColor("艾拉"));
    expect(speakerColor("艾拉", { 艾拉: "red" })).toBe("red");
  });
});

// ── Teaching the AI ──

const docWith = (el: Partial<UiElement>): UiDoc => ({
  version: 1,
  entryPageId: "p1",
  pages: [{ id: "p1", name: "Main", height: 812, elements: [{ id: "m", type: "messages", x: 0, y: 0, w: 375, h: 600, ...el } as UiElement] }],
});

describe("AI hints", () => {
  it("writes a hint per taught rule, with the creator's own text first", () => {
    const text = messageRulesPrompt([
      { ...thought, name: "心里话", aiHint: "害羞时用♡包住心里话。" },
      { ...choices, name: "选项" },
      { ...meta, teachAi: false },
    ], "zh")!;
    expect(text).toContain("- 心里话：害羞时用♡包住心里话。 例：♡其实……有一点开心。♡");
    expect(text).toContain("- 选项：每次回复的结尾给玩家 2–4 个可选的行动");
    expect(text).not.toContain("<!--");
  });

  it("generates a hint from the rule when none is written", () => {
    expect(defaultAiHint(thought, "en")).toBe("When a character has a thought they do not say aloud, wrap it in ♡…♡.");
  });

  it("creates, updates and removes the 界面约定 entry with the rules", () => {
    const other: WorldEntry = { id: "e1", name: "x", content: "y", role: "lore", alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all", enabled: true, position: 0, section: "post-history" };
    const created = syncMessageRulesEntry([other], docWith({ rules: [thought] }), "zh");
    const entry = created.find((e) => e.id === UI_RULES_ENTRY_ID)!;
    expect(entry).toMatchObject({ name: "界面约定", section: "post-history", alwaysSend: true, enabled: true, position: 1, audience: "ai" });
    expect(entry.content).toContain("♡…♡");

    // The creator switched it off and renamed it: an edit keeps both.
    const tweaked = created.map((e) => (e.id === UI_RULES_ENTRY_ID ? { ...e, enabled: false, name: "我的约定" } : e));
    const updated = syncMessageRulesEntry(tweaked, docWith({ rules: [thought, choices] }), "zh");
    expect(updated.find((e) => e.id === UI_RULES_ENTRY_ID)).toMatchObject({ enabled: false, name: "我的约定" });
    expect(updated.find((e) => e.id === UI_RULES_ENTRY_ID)!.content).toContain("※");

    // Unchanged rules: the same array back, so callers can skip a commit.
    expect(syncMessageRulesEntry(updated, docWith({ rules: [thought, choices] }), "zh")).toBe(updated);

    expect(syncMessageRulesEntry(updated, docWith({ rules: [] }), "zh")).toEqual([other]);
    expect(syncMessageRulesEntry([other], undefined, "zh")).toEqual([other]);
  });
});

describe("sample conversation", () => {
  it("shows every rule at work", () => {
    const sample = sampleConversation([banner, thought, speaker, choices, broadcast], "zh");
    const reply = layoutMessage(sample[2]!.content, [banner, thought, speaker, choices, broadcast], done);
    const kinds = new Set(reply.blocks.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(["banner", "choices", "speaker", "text"]);
    expect(reply.blocks.some((b) => b.kind === "text" && b.parts.some((p) => p.kind === "reveal"))).toBe(true);
    expect(layoutMessage(sample[1]!.content, [broadcast], done).card).not.toBeNull();
    // Choices are live only on the newest message, so the reply comes last.
    expect(sample[sample.length - 1]).toBe(sample[2]);
  });
});

describe("compile", () => {
  it("compiles byte-identically when a transcript has no design", () => {
    const plain = compileUiDoc(docWith({})).files["index.tsx"]!;
    expect(plain).toContain("<MessageList rendererComponent={null} />");
    expect(compileUiDoc(docWith({ rules: [] })).files["index.tsx"]).toBe(plain);
  });

  it("hands the design to the transcript as data, with its CSS", () => {
    const src = compileUiDoc(docWith({ rules: [thought], messageStyle: { showNames: false, maxWidth: 640 } })).files["index.tsx"]!;
    expect(src).toContain('<MessageList rendererComponent={null} design={{"style":{"showNames":false,"maxWidth":640},"rules":[');
    expect(src).toContain(':is(.play-message-role, .play-message-speaker) { display: none; }');
    expect(src).toContain("max-width: min(100%, 640px)");
  });

  it("a side the design draws owns its surface — no theme bubble around it", () => {
    for (const id of ["bubbles", "novel", "letter", "terminal"]) {
      const src = compileUiDoc(docWith({ messageStyle: MESSAGE_STYLE_PRESETS[id] })).files["index.tsx"]!;
      // Both platform boxes are stripped inside this part, after the token rules.
      expect(src, id).toMatch(/\.play-message-content:not\(\.play-user-message-content\) \{ background: transparent; padding: 0;/);
      expect(src, id).toMatch(/\.play-user-message-content \{ background: transparent; padding: 0;/);
    }
    // Without a bubble the player's line is prose in the column, not a pill on the right.
    const novel = compileUiDoc(docWith({ messageStyle: MESSAGE_STYLE_PRESETS.novel })).files["index.tsx"]!;
    expect(novel).toContain(".play-user-message-shell { align-items: stretch; }");
    expect(novel).toContain("width: auto; margin-left: 0; text-align: left;");
    const bubbles = compileUiDoc(docWith({ messageStyle: MESSAGE_STYLE_PRESETS.bubbles })).files["index.tsx"]!;
    expect(bubbles).not.toContain(".play-user-message-shell { align-items: stretch; }");
    // Rules alone leave the platform's (or the theme's) bubbles as they are.
    expect(compileUiDoc(docWith({ rules: [thought] })).files["index.tsx"]).not.toContain("background: transparent; padding: 0;");
  });

  it("every style preset reads on a light theme: ink and accent come from the card", () => {
    for (const id of ["bubbles", "novel", "letter"]) {
      const user = MESSAGE_STYLE_PRESETS[id]!.user!;
      expect(JSON.stringify(user), id).toContain("var(--yc-");
    }
  });

  it("passes the design through <Chat> too", () => {
    const doc = docWith({});
    doc.pages[0]!.elements = [{ id: "c", type: "chat", x: 0, y: 0, w: 375, h: 812, rules: [choices] }];
    expect(compileUiDoc(doc).files["index.tsx"]).toContain('<Chat design={{"style":{},"rules":[');
  });

  it("validates rules and styles, refusing a broken pattern", () => {
    expect(validateUiDoc(docWith({ rules: [thought, speaker], messageStyle: { assistant: { bubble: true, box: { padding: 12 } } } })).ok).toBe(true);
    const bad = validateUiDoc(docWith({ rules: [rule("x", { match: { kind: "regex", pattern: "([" }, show: "hide" })] }));
    expect(bad.ok).toBe(false);
  });
});
