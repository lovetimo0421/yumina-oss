import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCall } from "../llm/types.js";
import { describePlan, latestPlan, MAX_PLAN_STEPS, normalizePlan, PLAN_TOOL_NAME } from "./plan.js";
import { CONTROL_TOOL_NAMES, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "./tools.js";
import { WORLD_OPS } from "../world-ops.js";
import { ADVISOR_READ_TOOLS } from "../studio-advisor.js";

const call = (args: unknown, name = PLAN_TOOL_NAME): ToolCall =>
  ({ id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } });

describe("update_plan", () => {
  it("is a Studio read tool only: no outside AI and no advise mode", () => {
    assert.ok(READ_TOOL_NAMES.has(PLAN_TOOL_NAME));
    assert.ok(!WRITE_TOOL_NAMES.has(PLAN_TOOL_NAME) && !CONTROL_TOOL_NAMES.has(PLAN_TOOL_NAME));
    assert.ok(!WORLD_OPS.some((t) => t.function.name === PLAN_TOOL_NAME));
    assert.ok(!(ADVISOR_READ_TOOLS as readonly string[]).includes(PLAN_TOOL_NAME));
  });

  it("cleans a plan: blank steps dropped, unknown status pending, one step in progress", () => {
    const plan = normalizePlan({ plan: [
      { step: "  写角色条目 ", status: "in_progress" },
      { step: "", status: "pending" },
      { step: "加好感度变量", status: "in_progress" },
      { step: "试玩", status: "done" },
      "nonsense",
    ] });
    assert.deepEqual(plan, [
      { step: "写角色条目", status: "in_progress" },
      { step: "加好感度变量", status: "pending" },
      { step: "试玩", status: "pending" },
    ]);
  });

  it("rejects a call with no usable step and caps the length", () => {
    assert.equal(normalizePlan({ plan: [] }), null);
    assert.equal(normalizePlan({}), null);
    const many = normalizePlan({ plan: Array.from({ length: 30 }, (_, i) => ({ step: `s${i}`, status: "pending" })) });
    assert.equal(many!.length, MAX_PLAN_STEPS);
  });

  it("finds the latest plan among a turn's calls", () => {
    const calls = [
      call({ plan: [{ step: "a", status: "in_progress" }] }),
      call({ ids: ["x"] }, "read_entities"),
      call({ plan: [{ step: "a", status: "completed" }, { step: "b", status: "in_progress" }] }),
    ];
    assert.equal(describePlan(latestPlan(calls)!), "[x] a\n[>] b");
    assert.equal(latestPlan([calls[1]!]), null);
  });
});
