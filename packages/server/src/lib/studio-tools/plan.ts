import type { ToolCall, ToolDefinition } from "../llm/types.js";
import { parseToolArgs } from "./parse-tool-args.js";

/**
 * The assistant's checklist for a task of several steps (after Codex's
 * update_plan). The creator watches it tick over above the chat; the loop
 * keeps the latest one so it survives the earlier steps being summarized
 * away. It changes nothing on the card and costs no extra call: the model
 * sends it beside the round's other tools.
 */

export const PLAN_TOOL_NAME = "update_plan";
export const MAX_PLAN_STEPS = 10;
const MAX_STEP_CHARS = 120;

export type PlanStepStatus = "pending" | "in_progress" | "completed";
export interface PlanStep { step: string; status: PlanStepStatus }

export const UPDATE_PLAN_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: PLAN_TOOL_NAME,
    description:
      "Keep the checklist of a task with several steps, shown to the creator above the chat while you work. Call it when you start such a task (a job the creator started, or a request that takes several rounds): every step pending, the first in_progress. Call it again whenever a step is done or the plan changes, in the same response as that round's other tools, never on its own. Each call replaces the whole list. Steps are short, in the creator's language, about what the creator gets (not tool names). At most one step in_progress. The checklist closes by itself when you finish: never spend a round only to mark the last step completed, give your final reply instead. Not for a small edit you finish in one or two rounds.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          description: `The whole checklist, in order, at most ${MAX_PLAN_STEPS} steps.`,
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "One step, a few words." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["plan"],
    },
  },
};

/** The checklist a call asks for, cleaned up; null when it has no usable step. */
export function normalizePlan(args: unknown): PlanStep[] | null {
  const raw = args && typeof args === "object" ? (args as { plan?: unknown }).plan : undefined;
  if (!Array.isArray(raw)) return null;
  const steps: PlanStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const step = typeof (item as { step?: unknown }).step === "string" ? (item as { step: string }).step.trim().slice(0, MAX_STEP_CHARS) : "";
    if (!step) continue;
    const status = (item as { status?: unknown }).status;
    steps.push({ step, status: status === "completed" || status === "in_progress" ? status : "pending" });
    if (steps.length >= MAX_PLAN_STEPS) break;
  }
  if (steps.length === 0) return null;
  // One step at a time: a second in_progress waits its turn.
  let current = false;
  for (const s of steps) {
    if (s.status !== "in_progress") continue;
    if (current) s.status = "pending";
    current = true;
  }
  return steps;
}

/** The latest checklist among these calls, if any asked for one. */
export function latestPlan(calls: ToolCall[]): PlanStep[] | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]!.function.name !== PLAN_TOOL_NAME) continue;
    try {
      const plan = normalizePlan(parseToolArgs(calls[i]!.function.arguments));
      if (plan) return plan;
    } catch { /* a malformed call names no plan */ }
  }
  return null;
}

/** One line per step, for the model's summary of earlier rounds. */
export function describePlan(plan: PlanStep[]): string {
  const mark = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;
  return plan.map((s) => `${mark[s.status]} ${s.step}`).join("\n");
}
