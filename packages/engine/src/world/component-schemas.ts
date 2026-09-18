import { z } from "zod";

// ── Per-type config schemas ──

export const statBarConfigSchema = z.object({
  variableId: z.string(),
  color: z.string().optional(),
  showValue: z.boolean().optional(),
  showLabel: z.boolean().optional(),
  secondaryVariableId: z.string().optional(),
});

export const textDisplayConfigSchema = z.object({
  variableId: z.string(),
  format: z.string().optional(),
  fontSize: z.enum(["sm", "md", "lg"]).optional(),
  icon: z.string().optional(),
  textColor: z.string().optional(),
});

export const imagePanelConfigSchema = z.object({
  variableId: z.string().optional(),
  url: z.string().optional(),
  aspectRatio: z.enum(["square", "portrait", "landscape", "wide"]).optional(),
  size: z.enum(["sm", "md", "lg", "full"]).optional(),
  placement: z.enum(["left", "center", "right"]).optional(),
  fallbackUrl: z.string().optional(),
});

export const inventoryGridConfigSchema = z.object({
  variableId: z.string(),
  columns: z.number().int().positive().optional(),
  maxSlots: z.number().int().positive().optional(),
});

export const webPanelConfigSchema = z.object({
  htmlUrl: z.string().optional(),
  html: z.string().optional(),
  cssUrl: z.string().optional(),
  css: z.string().optional(),
  jsUrl: z.string().optional(),
  js: z.string().optional(),
  height: z.number().int().positive().optional(),
  sandbox: z.string().optional(),
});

// ── Base fields shared by all components ──

const baseComponentFields = {
  id: z.string(),
  name: z.string().min(1),
  order: z.number().int().default(0),
  visible: z.boolean().optional(),
  placement: z.enum(["header"]).optional().default("header"),
};

// ── Per-type component schemas ──

const statBarComponentSchema = z.object({
  ...baseComponentFields,
  type: z.literal("stat-bar"),
  config: statBarConfigSchema,
});

const textDisplayComponentSchema = z.object({
  ...baseComponentFields,
  type: z.literal("text-display"),
  config: textDisplayConfigSchema,
});

const imagePanelComponentSchema = z.object({
  ...baseComponentFields,
  type: z.literal("image-panel"),
  config: imagePanelConfigSchema,
});

const inventoryGridComponentSchema = z.object({
  ...baseComponentFields,
  type: z.literal("inventory-grid"),
  config: inventoryGridConfigSchema,
});

const webPanelComponentSchema = z.object({
  ...baseComponentFields,
  type: z.literal("web-panel"),
  config: webPanelConfigSchema,
});

// ── Discriminated union schema ──

export const gameComponentSchema = z.discriminatedUnion("type", [
  statBarComponentSchema,
  textDisplayComponentSchema,
  imagePanelComponentSchema,
  inventoryGridComponentSchema,
  webPanelComponentSchema,
]);
