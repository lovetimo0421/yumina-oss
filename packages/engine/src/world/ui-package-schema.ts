import { z } from "zod";
import { gameComponentSchema } from "./component-schemas.js";
import { uiBlueprintSchema } from "./ui-blueprint-schema.js";

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "schemaVersion must be semver");

const uiPackageMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  uiType: z.enum([
    "status-bar",
    "text-background",
    "image-showcase",
    "inventory",
    "dashboard",
    "narrative-overlay",
    "custom",
  ]),
  implementation: z.enum([
    "stat-bar",
    "text-display",
    "image-panel",
    "inventory-grid",
    "web-panel",
    "ui-blueprint-only",
    "message-renderer",
    "hybrid",
  ]),
  tags: z.array(z.string()).default([]),
  authoringMode: z.enum(["ai-generated", "ai-transported", "manual"]).default("ai-generated"),
}).strict();

const uiPackageSummarySchema = z.object({
  whatThisAdds: z.array(z.string()).default([]),
  requiresVariableIds: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
}).strict();

const uiPackageMessageRendererSchema = z.object({
  enabled: z.boolean().default(false),
  name: z.string().default(""),
  tsxCode: z.string().default(""),
}).strict();

const uiPackageDisplaySettingsSchema = z.object({
  fullScreenComponent: z.boolean().default(false),
}).strict();

export const uiPackageSchema = z.object({
  format: z.literal("yumina.ui-package"),
  schemaVersion: semverSchema.default("1.0.0"),
  metadata: uiPackageMetadataSchema,
  summary: uiPackageSummarySchema,
  uiBlueprint: uiBlueprintSchema,
  legacyComponents: z.array(gameComponentSchema).default([]),
  messageRenderer: uiPackageMessageRendererSchema,
  displaySettings: uiPackageDisplaySettingsSchema,
}).strict();

export {
  uiPackageMetadataSchema,
  uiPackageSummarySchema,
  uiPackageMessageRendererSchema,
  uiPackageDisplaySettingsSchema,
};
