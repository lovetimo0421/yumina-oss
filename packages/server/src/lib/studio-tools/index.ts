// Shared types (moved from legacy executor.ts)
export interface ToolResult {
  tool_call_id: string;
  name: string;
  status: "success" | "error";
  result: unknown;
  error?: string;
}

// Studio skills
export { getTemplateCatalogSummary, readTemplateContent, readTemplateMeta, getHybridSkillContent, getSkillContent } from "../studio-skills/index.js";

// Agent tools & executor
export { STUDIO_TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, CONTROL_TOOL_NAMES } from "./tools.js";
export { resolveContext } from "./context-resolver.js";
export { executeReadEntities, executeApplyChanges, classifyApproval, toolCallsToSchemaChanges, type SchemaChange } from "./tool-executor.js";
export { buildSystemPrompt } from "./system-prompt.js";
