import { extractVariableReadsFromFiles } from "@yumina/engine";
import type { Variable, WorldDefinition } from "@yumina/engine";

export type VariableReferenceArea = "entry" | "variable" | "behavior" | "rule" | "module" | "interface" | "audio" | "scene" | "bundle" | "settings";
export interface VariableIdReference {
  area: VariableReferenceArea;
  owner: string;
  /** Exact schema location, useful even when an object has no display name. */
  path: string;
}
export interface VariableCodeReview {
  file: string;
  reason: "name" | "dynamic" | "id";
}
export interface VariableIdUsage {
  references: VariableIdReference[];
  /** Source scanning is advisory, never presented as a proven ID reference. */
  codeReviews: VariableCodeReview[];
}

const referenceKeys = new Set(["variableId", "secondaryVariableId", "conditionVariableId", "valueRef", "candidatesVar", "historyVar"]);
const literalKeys = new Set(["defaultValue", "conditionValue", "fallback", "candidates", "items"]);
const templateKeys = new Set(["content", "template", "message", "systemPrompt", "greeting", "task", "archivePrompt"]);

/** Enumerate authoring references without editing the draft or guessing at code.
 * Literal condition values, JSON data and plain prose are deliberately opaque.
 * The sandbox variables bag uses display NAMES; its scan is a separate review
 * list, not evidence that changing a technical ID would change that binding. */
export function getVariableIdUsage(world: WorldDefinition, variable: Variable): VariableIdUsage {
  const references: VariableIdReference[] = [];
  const codeReviews: VariableCodeReview[] = [];
  const seen = new Set<string>();
  const id = variable.id;
  const matches = (value: unknown): value is string => typeof value === "string" && (value === id || value.startsWith(`${id}.`) || value.startsWith(`${id}[`));
  const add = (area: VariableReferenceArea, owner: string, path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    references.push({ area, owner, path });
  };
  const code = (file: string, source: unknown) => {
    if (typeof source !== "string") return;
    const scan = extractVariableReadsFromFiles({ [file]: source });
    if (scan.names.includes(variable.name) || scan.writes.includes(variable.name)) codeReviews.push({ file, reason: "name" });
    if (scan.dynamicReads || scan.dynamicWrites) codeReviews.push({ file, reason: "dynamic" });
    // ID text is only a review hint: a quoted "hp" could just be a caption.
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const idAccess = new RegExp(`(?:[\"']${escaped}[\"']|\\{\\{\\s*${escaped}(?:[.\\[]|\\s*\\}\\}))`);
    if (idAccess.test(source)) codeReviews.push({ file, reason: "id" });
  };
  const walk = (value: unknown, area: VariableReferenceArea, owner: string, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, i) => walk(child, area, owner, `${path}[${i}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(object)) {
      const childPath = `${path}.${key}`;
      if (referenceKeys.has(key)) {
        if (matches(child)) add(area, owner, childPath);
        continue;
      }
      if (key === "initialVariables" && child && typeof child === "object") {
        if (Object.hasOwn(child, id)) add(area, owner, `${childPath}[${JSON.stringify(id)}]`);
        continue;
      }
      if (key === "path" && typeof child === "string") {
        const target = child.startsWith("@vars.enabled.") ? child.slice("@vars.enabled.".length) : child;
        if (matches(target)) add(area, owner, childPath);
        // The legacy interface resolver accepts vars.hp / variables.hp paths.
        if (area === "interface") {
          const variablePath = child.replace(/^vars\./, "").replace(/^vars\[['"]([^'"]+)['"]\]/, "$1");
          if (matches(variablePath)) add(area, owner, childPath);
        }
      }
      const directiveValue = key === "value" && object.type === "set" && typeof object.path === "string" && object.path.startsWith("@prompt.directive.");
      if ((templateKeys.has(key) || directiveValue) && typeof child === "string") {
        for (const match of child.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
          if (matches(match[1]!.trim())) add(area, owner, childPath);
        }
      }
      if (["html", "js", "tsxCode", "expression", "when"].includes(key) && typeof child === "string") code(childPath, child);
      if (literalKeys.has(key)) continue;
      // Legacy directive effects also carry an object {content, position, ...}.
      // Its content is interpolated by PromptBuilder, unlike ordinary JSON.
      if (directiveValue) { walk(child, area, owner, childPath); continue; }
      // Values of comparisons and effects are user data. UiNumber.value and
      // meter.value are configuration objects, so only skip known literals.
      if (key === "value" && ("operator" in object || object.type === "set" || object.type === "modify-variable" || object.kind === "set-variable" || object.kind === "literal")) continue;
      walk(child, area, owner, childPath);
    }
  };
  const collection = (items: readonly unknown[] | undefined, area: VariableReferenceArea, path: string) => {
    (items ?? []).forEach((item, i) => {
      const object = item as { name?: string; id?: string };
      walk(item, area, object.name || object.id || `${i + 1}`, `${path}[${i}]`);
    });
  };
  collection(world.entries, "entry", "entries");
  collection(world.variables, "variable", "variables");
  collection(world.rules, "rule", "rules");
  collection(world.reactions, "behavior", "reactions");
  (world.reactions ?? []).forEach((reaction, i) => {
    if (matches(reaction.when.match?.variableId?.value)) add("behavior", reaction.name || reaction.id, `reactions[${i}].when.match.variableId.value`);
  });
  collection(world.worldbooks, "module", "worldbooks");
  collection(world.loreUiBindings, "interface", "loreUiBindings");
  collection(world.components, "interface", "components");
  collection(world.conditionalBGM, "audio", "conditionalBGM");
  collection(world.scenes, "scene", "scenes");
  collection(world.lorebookEntries, "entry", "lorebookEntries");
  collection(world.characters, "entry", "characters");
  walk(world.uiDoc, "interface", "uiDoc", "uiDoc");
  walk(world.uiBlueprint, "interface", "uiBlueprint", "uiBlueprint");
  walk(world.settings, "settings", world.name, "settings");
  (world.installedBundles ?? []).forEach((bundle, i) => {
    if (bundle.variableIds.includes(id)) add("bundle", bundle.name, `installedBundles[${i}].variableIds`);
  });
  for (const [file, source] of Object.entries(world.rootComponent?.files ?? {})) code(file, source);
  (world.customUI ?? []).forEach((component) => code(component.name || component.id, component.tsxCode));
  return { references, codeReviews };
}

/** Every top-level world field getVariableIdUsage reads (rootComponent is
 * read only for its files). Memoize a usage scan on variableUsageInputs()
 * plus the variable's id/name instead of the whole world object: unrelated
 * edits (card description, greeting text) then no longer rescan every entry
 * and every interface file. A test proxies the world to keep this in sync. */
export const VARIABLE_USAGE_WORLD_KEYS = [
  "name",
  "entries",
  "variables",
  "rules",
  "reactions",
  "worldbooks",
  "loreUiBindings",
  "components",
  "conditionalBGM",
  "scenes",
  "lorebookEntries",
  "characters",
  "uiDoc",
  "uiBlueprint",
  "settings",
  "installedBundles",
  "customUI",
] as const satisfies readonly (keyof WorldDefinition)[];

export function variableUsageInputs(world: WorldDefinition): readonly unknown[] {
  return [...VARIABLE_USAGE_WORLD_KEYS.map((key) => world[key]), world.rootComponent?.files];
}
