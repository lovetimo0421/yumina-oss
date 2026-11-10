import { describe, expect, it } from "vitest";
import { applyReplyRules, readPairs, replyRouteOps } from "./reply-rules.js";

const world = {
  variables: [
    { id: "hp", name: "HP", type: "number", defaultValue: 100 },
    { id: "place", name: "地点", type: "string", defaultValue: "" },
    { id: "log", name: "日志", type: "json", defaultValue: [] },
  ],
  replyRules: [
    { id: "status", match: { tag: "状态" }, hide: true, to: [{ kind: "fields" }] },
    { id: "options", match: { tag: "选项" }, hide: true, to: [{ kind: "channel", channel: "选项按钮" }] },
    { id: "forum", match: { pattern: "【论坛更新】([^\\n]+)" }, to: [{ kind: "variable", variableId: "日志", op: "push" }, { kind: "event", name: "论坛更新" }] },
    { id: "off", enabled: false, match: { tag: "think" }, hide: true },
  ],
} as never;

describe("reply rules", () => {
  it("take blocks out, write their fields, route the rest", () => {
    const text = "「……你们来晚了。」\n<状态>HP: 62 | 地点：地下城</状态>\n<选项>1.追上去|2.先包扎</选项>\n【论坛更新】有人在地下城看到了龙\n<think>secret</think>";
    const r = applyReplyRules(world, text);
    expect(r.text).toBe("「……你们来晚了。」\n\n\n【论坛更新】有人在地下城看到了龙\n<think>secret</think>".replace(/\n{3,}/g, "\n\n"));
    expect(r.effects).toEqual([
      { variableId: "hp", operation: "set", value: 62 },
      { variableId: "place", operation: "set", value: "地下城" },
      { variableId: "log", operation: "push", value: "有人在地下城看到了龙" },
    ]);
    expect(r.channels).toEqual([{ channel: "选项按钮", text: "1.追上去|2.先包扎", rule: "options" }]);
    expect(r.events).toEqual(["论坛更新"]);
  });

  it("read pairs in lines or with bars", () => {
    expect(readPairs("HP:62\n地点 ： 地下城｜心情=好")).toEqual([["HP", "62"], ["地点", "地下城"], ["心情", "好"]]);
  });

  it("leave a card without rules alone", () => {
    expect(applyReplyRules({ variables: [] } as never, "x <状态>a</状态>").text).toBe("x <状态>a</状态>");
  });

  it("never treat an empty pattern, or the empty matches of a loose one, as blocks", () => {
    const rules = (pattern: string) => ({
      variables: [],
      replyRules: [{ id: "r", match: { pattern }, hide: true, to: [{ kind: "channel", channel: "side" }] }],
    }) as never;
    for (const pattern of ["", "  "]) {
      const r = applyReplyRules(rules(pattern), "a reply");
      expect(r.channels).toEqual([]);
      expect(r.text).toBe("a reply");
    }
    expect(applyReplyRules(rules("x*"), "axxb").channels).toEqual([{ channel: "side", text: "xx", rule: "r" }]);
  });

  it("route a whole block into a variable the way its type can take it", () => {
    const vars = {
      variables: [
        { id: "hp", name: "HP", type: "number", defaultValue: 100 },
        { id: "awake", name: "醒着", type: "boolean", defaultValue: false },
        { id: "note", name: "笔记", type: "string", defaultValue: "" },
        { id: "log", name: "日志", type: "json", defaultValue: [] },
      ],
    };
    const run = (variableId: string, op: "set" | "append" | "push" | undefined, block: string) =>
      applyReplyRules({ ...vars, replyRules: [{ id: "r", match: { tag: "b" }, to: [{ kind: "variable", variableId, op }] }] } as never, `<b>${block}</b>`).effects;
    // A number takes the number in the block, or nothing — never NaN.
    expect(run("hp", "set", "HP 62/100")).toEqual([{ variableId: "hp", operation: "set", value: 62 }]);
    expect(run("hp", "set", "unhurt")).toEqual([]);
    expect(run("awake", undefined, "是")).toEqual([{ variableId: "awake", operation: "set", value: true }]);
    expect(run("note", "append", "line")).toEqual([{ variableId: "note", operation: "append", value: "line" }]);
    // A list is not overwritten by a string: the block is one more item,
    // unless it is JSON itself.
    expect(run("log", undefined, "dragon seen")).toEqual([{ variableId: "log", operation: "push", value: "dragon seen" }]);
    expect(run("log", "set", "dragon seen")).toEqual([]);
    expect(run("log", "set", '["a","b"]')).toEqual([{ variableId: "log", operation: "set", value: ["a", "b"] }]);
    expect(replyRouteOps("number")).toEqual(["set"]);
    expect(replyRouteOps("json")[0]).toBe("push");
  });
});
