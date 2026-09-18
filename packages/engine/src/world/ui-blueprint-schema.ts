import { z } from "zod";

const uiBlueprintConditionSchema = z.object({
  variableId: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
  value: z.union([z.number(), z.string(), z.boolean()]),
});

const uiBlueprintTriggerSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  expression: z.string().optional(),
  conditions: z.array(uiBlueprintConditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"),
  enabled: z.boolean().default(true),
});

const uiBlueprintLayoutSchema = z.object({
  id: z.string(),
  type: z.enum(["stack", "grid", "tabs", "overlay", "split", "panel"]),
  name: z.string().optional(),
  placement: z.enum(["header"]).optional(),
  order: z.number().int().default(0),
  columns: z.number().int().positive().optional(),
  gap: z.number().int().nonnegative().optional(),
  componentIds: z.array(z.string()).default([]),
  triggerIds: z.array(z.string()).default([]),
  triggerLogic: z.enum(["all", "any"]).default("all"),
  when: z.string().optional(),
  visible: z.boolean().default(true),
});

const uiBlueprintComponentSchema = z.object({
  id: z.string(),
  type: z.enum([
    "text",
    "metric",
    "progress",
    "badge",
    "list",
    "table",
    "image",
    "choiceGroup",
    "form",
    "webPanel",
  ]),
  name: z.string().optional(),
  layoutId: z.string().optional(),
  placement: z.enum(["header"]).optional(),
  order: z.number().int().default(0),
  props: z.record(z.unknown()).default({}),
  triggerIds: z.array(z.string()).default([]),
  triggerLogic: z.enum(["all", "any"]).default("all"),
  when: z.string().optional(),
  visible: z.boolean().default(true),
});

const uiBlueprintBindingSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  prop: z.string(),
  path: z.string(),
  transform: z
    .enum(["string", "number", "boolean", "percent", "jsonArrayLength"])
    .optional(),
  fallback: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const uiBlueprintInteractionSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  event: z.enum(["click", "submit", "change"]),
  action: z.enum([
    "setVariable",
    "sendMessage",
    "executeAction",
    "openPanel",
    "switchLayout",
  ]),
  payload: z.record(z.unknown()).optional(),
});

export const uiBlueprintSchema = z.object({
  version: z.string().default("1.0"),
  theme: z
    .object({
      preset: z.string().optional(),
      tokens: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    })
    .optional(),
  layouts: z.array(uiBlueprintLayoutSchema).default([]),
  components: z.array(uiBlueprintComponentSchema).default([]),
  bindings: z.array(uiBlueprintBindingSchema).default([]),
  triggers: z.array(uiBlueprintTriggerSchema).default([]),
  interactions: z.array(uiBlueprintInteractionSchema).default([]),
});

export {
  uiBlueprintConditionSchema,
  uiBlueprintTriggerSchema,
  uiBlueprintLayoutSchema,
  uiBlueprintComponentSchema,
  uiBlueprintBindingSchema,
  uiBlueprintInteractionSchema,
};
