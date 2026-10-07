import { describe, expect, it } from "vitest";
import { applyReplyRules, readPairs } from "./reply-rules.js";

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
});
