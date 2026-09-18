import type { WorldDefinition } from "../types/index.js";

export interface WorldWarning {
  type:
    | "orphaned-var-ref"
    | "keywords-on-always-send"
    | "empty-content"
    | "rule-refs-deleted-var"
    | "unused-variable";
  severity: "warning" | "info";
  message: string;
  entityId?: string;
  entityName?: string;
}

/**
 * Validates a world definition and returns warnings about potential issues.
 * Pure function — no side effects, no framework dependencies.
 */
export function validateWorld(world: WorldDefinition): WorldWarning[] {
  const warnings: WorldWarning[] = [];
  const variableIds = new Set(world.variables.map((v) => v.id));

  // Track which variables are referenced (for unused-variable check)
  const referencedVarIds = new Set<string>();

  // 1. Check rules for orphaned variable references
  for (const rule of world.rules) {
    for (const cond of rule.conditions) {
      if (!variableIds.has(cond.variableId)) {
        warnings.push({
          type: "rule-refs-deleted-var",
          severity: "warning",
          message: `Rule "${rule.name}" condition references non-existent variable "${cond.variableId}"`,
          entityId: rule.id,
          entityName: rule.name,
        });
      } else {
        referencedVarIds.add(cond.variableId);
      }
    }
    // Check actions for variable references (Rules 2.0)
    for (const action of rule.actions ?? []) {
      if (action.type === "modify-variable") {
        if (!variableIds.has(action.variableId)) {
          warnings.push({
            type: "rule-refs-deleted-var",
            severity: "warning",
            message: `Rule "${rule.name}" action references non-existent variable "${action.variableId}"`,
            entityId: rule.id,
            entityName: rule.name,
          });
        } else {
          referencedVarIds.add(action.variableId);
        }
      }
    }
    // Also check trigger variableId (for variable-crossed)
    if (rule.trigger?.variableId) {
      if (!variableIds.has(rule.trigger.variableId)) {
        warnings.push({
          type: "rule-refs-deleted-var",
          severity: "warning",
          message: `Rule "${rule.name}" trigger references non-existent variable "${rule.trigger.variableId}"`,
          entityId: rule.id,
          entityName: rule.name,
        });
      } else {
        referencedVarIds.add(rule.trigger.variableId);
      }
    }
  }

  // 2. Check components for variable references
  for (const comp of world.components) {
    const config = comp.config as unknown as Record<string, unknown>;
    if (config.variableId && typeof config.variableId === "string") {
      referencedVarIds.add(config.variableId);
    }
  }

  // 2b. Check uiBlueprint references
  if (world.uiBlueprint) {
    for (const trigger of world.uiBlueprint.triggers ?? []) {
      for (const cond of trigger.conditions ?? []) {
        if (!variableIds.has(cond.variableId)) {
          warnings.push({
            type: "orphaned-var-ref",
            severity: "warning",
            message: `uiBlueprint trigger "${trigger.id}" references non-existent variable "${cond.variableId}"`,
            entityId: trigger.id,
            entityName: trigger.name ?? trigger.id,
          });
        } else {
          referencedVarIds.add(cond.variableId);
        }
      }
    }

    for (const binding of world.uiBlueprint.bindings ?? []) {
      const referenced = extractVarIdsFromPath(binding.path);
      for (const variableId of referenced) {
        if (!variableIds.has(variableId)) {
          warnings.push({
            type: "orphaned-var-ref",
            severity: "warning",
            message: `uiBlueprint binding "${binding.id}" references non-existent variable "${variableId}"`,
            entityId: binding.id,
            entityName: binding.id,
          });
        } else {
          referencedVarIds.add(variableId);
        }
      }
    }
  }

  // 3. Check entries for issues
  for (const entry of world.entries) {
    // Keywords on alwaysSend entries (keywords are ignored)
    if (
      entry.alwaysSend &&
      entry.keywords.length > 0 &&
      entry.enabled
    ) {
      warnings.push({
        type: "keywords-on-always-send",
        severity: "info",
        message: `Entry "${entry.name}" has keywords but alwaysSend is enabled — keywords are ignored`,
        entityId: entry.id,
        entityName: entry.name,
      });
    }

    // Empty content on enabled entries
    if (entry.enabled && !entry.content.trim()) {
      warnings.push({
        type: "empty-content",
        severity: "warning",
        message: `Entry "${entry.name}" is enabled but has empty content`,
        entityId: entry.id,
        entityName: entry.name,
      });
    }

    // Check entry conditions for orphaned variable refs
    if (entry.conditions) {
      for (const cond of entry.conditions) {
        if (!variableIds.has(cond.variableId)) {
          warnings.push({
            type: "orphaned-var-ref",
            severity: "warning",
            message: `Entry "${entry.name}" condition references non-existent variable "${cond.variableId}"`,
            entityId: entry.id,
            entityName: entry.name,
          });
        } else {
          referencedVarIds.add(cond.variableId);
        }
      }
    }
  }

  // 4. Unused variables (not referenced by any rule, component, or entry condition)
  for (const variable of world.variables) {
    if (!referencedVarIds.has(variable.id)) {
      warnings.push({
        type: "unused-variable",
        severity: "info",
        message: `Variable "${variable.name}" is not referenced by any rule, component, or entry condition`,
        entityId: variable.id,
        entityName: variable.name,
      });
    }
  }

  return warnings;
}

function extractVarIdsFromPath(path: string): string[] {
  const text = path.trim();
  if (!text.startsWith("vars")) return [];

  const bracket = text.match(/^vars\[['"]([^'"]+)['"]\]/);
  if (bracket?.[1]) return [bracket[1]];

  const dot = text.match(/^vars\.([A-Za-z0-9_-]+)/);
  if (dot?.[1]) return [dot[1]];

  return [];
}
