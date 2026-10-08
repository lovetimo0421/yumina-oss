/**
 * Studio AI Executor
 *
 * Handles the two batch tools: read_entities + apply_changes.
 * Reuses entity CRUD logic from executor.ts but with batch semantics
 * and atomic validation (all-or-nothing on failure).
 */

import type {
  WorldDefinition,
  WorldEntry,
  Variable,
  Rule,
  Reaction,
  ReactionEffect,
  AudioTrack,
  SceneImage,
  Condition,
  Worldbook,
  LoreUiBinding,
} from "@yumina/engine";
import type { EventPattern, EventMatchCondition, VariableActivation } from "@yumina/engine";
import { deriveSectionDefaults, deriveSectionDefaultsForEntry, isVariableBoundEntry, estimateTokens, moduleStationSchema, uiKnobGroupsSchema, withPreciseTrackingDefault, worldDefinitionSchema } from "@yumina/engine";
import { isValidTtsVoice } from "@yumina/shared";
import crypto from "crypto";
import { posix } from "node:path";
import { parseToolArgs } from "./parse-tool-args.js";
import { toStringArray, computeLorebookHealth, LOREBOOK_BUDGETS } from "./context-resolver.js";
import { assertNoInlineDataUris as assertNoInlineDataUrisShared, scanTextForInlineDataUris } from "../asset-validation.js";
import { validateTsx, formatTsxIssue } from "./tsx-validate.js";
import { resolveUniqueMatch, nearestRegion } from "./fuzzy-match.js";
import { analyzeRootUiReachability, rootUiConnectionNote } from "./root-ui-reachability.js";
import { applyUiDocOps, compileUiDocInto, uiDocOwnedFileError } from "./ui-doc-tools.js";

/** Find up to 3 IDs similar to the given ID (prefix or substring match) for error hints */
function suggestSimilarIds(target: string, allIds: string[]): string {
  const lower = target.toLowerCase();
  const matches = allIds
    .filter((id) => id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase()) || id.toLowerCase().startsWith(lower.slice(0, 4)))
    .slice(0, 3);
  return matches.length > 0 ? ` Did you mean: ${matches.map((id) => `"${id}"`).join(", ")}?` : "";
}

// ── SchemaChange Type ──

export interface SchemaChange {
  action: "create" | "update" | "delete";
  entityType: "entry" | "variable" | "rule" | "behavior" | "customUI" | "audio" | "sceneImage" | "settings" | "worldbook" | "loreBinding" | "uiKnobs" | "uiKnobGroups" | "uiDoc";
  id?: string;
  data?: Record<string, unknown>;
}

export interface ApplyChangesResult {
  /** The mutated world (only if ALL changes passed validation) */
  world: WorldDefinition;
  /** Per-change results */
  results: ChangeResult[];
  /** Whether all changes were applied successfully */
  success: boolean;
  /** Summary for the LLM */
  summary: string;
}

export interface ChangeResult {
  index: number;
  action: string;
  entityType: string;
  id: string;
  status: "success" | "error";
  error?: string;
  /** Extra info for the LLM (e.g. "replaced old-renderer") */
  note?: string;
}

// ── Approval Classification ──

export interface ApprovalDecision {
  autoExecute: boolean;
  reason: string;
}

/**
 * Determine whether a batch of changes should auto-execute or require user approval.
 *
 * Auto-execute: creates/updates with <5 entities and no deletes
 * Confirm: deletes, TSX code, settings, 5+ entities
 */
export function classifyApproval(changes: SchemaChange[]): ApprovalDecision {
  if (changes.length === 0) {
    return { autoExecute: true, reason: "empty" };
  }

  const hasDeletes = changes.some((c) => c.action === "delete");
  if (hasDeletes) {
    return { autoExecute: false, reason: "contains deletes" };
  }

  const hasTSX = changes.some(
    (c) => c.entityType === "customUI" && c.data?.tsxCode && (c.data?.language ?? "tsx") === "tsx",
  );
  if (hasTSX) {
    return { autoExecute: false, reason: "contains TSX code" };
  }

  // Installing a decomposition rewrites the base frontend's code — always a
  // reviewed proposal, never silent, however few tool calls carried it.
  if (changes.some((c) => c.entityType === "uiKnobGroups")) {
    return { autoExecute: false, reason: "decomposes the base frontend" };
  }

  // Leaving the visual editor for code is a one-way handover — always reviewed.
  if (changes.some((c) => c.entityType === "uiDoc" && Array.isArray(c.data?.ops) && (c.data.ops as Array<{ op?: unknown }>).some((o) => o?.op === "detach_to_code"))) {
    return { autoExecute: false, reason: "detaches the interface document" };
  }

  const hasSettings = changes.some((c) => c.entityType === "settings");
  if (hasSettings) {
    return { autoExecute: false, reason: "contains settings changes" };
  }

  if (changes.length >= 5) {
    return { autoExecute: false, reason: `${changes.length} entities (threshold: 5)` };
  }

  return { autoExecute: true, reason: "safe changes" };
}

// ── Read Entities ──

const DEFAULT_LIMIT_LINES = 2000;
const MAX_LIMIT_LINES = 5000;

/** Apply 1-based offset/limit slicing to a tsxCode payload, prepending a header
 *  so the model sees exactly which slice it got. No-op when neither param is set. */
function sliceTsxContent(
  payload: Record<string, unknown>,
  offsetLines: number | undefined,
  limitLines: number | undefined,
): Record<string, unknown> {
  if (offsetLines === undefined && limitLines === undefined) return payload;
  const code = String(payload.tsxCode ?? "");
  if (!code) return payload;

  const lines = code.split("\n");
  const total = lines.length;
  const offset = Math.max(1, Math.floor(offsetLines ?? 1));
  const limit = Math.min(MAX_LIMIT_LINES, Math.max(1, Math.floor(limitLines ?? DEFAULT_LIMIT_LINES)));
  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, total);

  if (startIdx >= total) {
    return {
      ...payload,
      tsxCode: `// Lines ${offset}-${offset} of ${total} (past end of file). Use a smaller offset_lines or omit it to read from the start.`,
      _sliced: { offset, limit, total, returned: 0 },
    };
  }

  const header = `// Showing lines ${offset}-${endIdx} of ${total}. Use offset_lines/limit_lines to read a different slice, or grep_world to find content by query.`;
  return {
    ...payload,
    tsxCode: `${header}\n${lines.slice(startIdx, endIdx).join("\n")}`,
    _sliced: { offset, limit, total, returned: endIdx - startIdx },
  };
}

export interface ReadEntitiesParams {
  offset_lines?: number;
  limit_lines?: number;
}

/**
 * Batch read entities by ID. Looks up each ID across all entity arrays.
 * For TSX entities (customUI, rootComponent files), optional offset_lines/limit_lines
 * slice the content — useful for huge files where a full read blows the context budget.
 */
export function executeReadEntities(
  world: WorldDefinition,
  ids: string[],
  params: ReadEntitiesParams = {},
): { results: Record<string, unknown | null> } {
  const results: Record<string, unknown | null> = {};
  const { offset_lines, limit_lines } = params;
  const paginated = offset_lines !== undefined || limit_lines !== undefined;

  for (const id of ids) {
    // Search across all entity types
    const entry = world.entries.find((e) => e.id === id);
    if (entry) { results[id] = { ...entry, _type: "entry" }; continue; }

    const variable = world.variables.find((v) => v.id === id);
    if (variable) { results[id] = { ...variable, _type: "variable" }; continue; }

    const reaction = (world.reactions ?? []).find((r) => r.id === id);
    if (reaction) { results[id] = { ...reaction, _type: "behavior" }; continue; }

    const rule = world.rules.find((r) => r.id === id);
    if (rule) { results[id] = { ...rule, _type: "rule" }; continue; }

    const ui = (world.customUI ?? []).find((c) => c.id === id);
    if (ui) {
      const payload: Record<string, unknown> = { ...ui, _type: "customUI" };
      results[id] = paginated ? sliceTsxContent(payload, offset_lines, limit_lines) : payload;
      continue;
    }

    // Root component — expose as customUI-shaped object so agent sees consistent format
    if (world.rootComponent) {
      const rc = world.rootComponent;

      // Match by rootComponent UUID or "root-component" alias → return entry file
      if (id === rc.id || id === "root-component") {
        const payload: Record<string, unknown> = {
          _type: "customUI",
          id: rc.id,
          name: rc.name,
          tsxCode: rc.files[rc.entryFile] ?? "",
          description: `Root component (entry: ${rc.entryFile}, files: [${Object.keys(rc.files).join(", ")}])`,
          visible: true,
          updatedAt: rc.updatedAt,
        };
        results[id] = paginated ? sliceTsxContent(payload, offset_lines, limit_lines) : payload;
        continue;
      }

      // Match by filename (e.g. "homepage.tsx") → return that specific file
      if (id in rc.files) {
        const payload: Record<string, unknown> = {
          _type: "customUI",
          id,
          name: `${rc.name} / ${id}`,
          tsxCode: rc.files[id] ?? "",
          description: `Root component file (${id === rc.entryFile ? "entry file" : "sub-file"})`,
          visible: true,
          updatedAt: rc.updatedAt,
        };
        results[id] = paginated ? sliceTsxContent(payload, offset_lines, limit_lines) : payload;
        continue;
      }
    }

    const audio = (world.audioTracks ?? []).find((a) => a.id === id);
    if (audio) { results[id] = { ...audio, _type: "audio" }; continue; }

    const sceneImage = (world.sceneImages ?? []).find((img) => img.id === id);
    if (sceneImage) { results[id] = { ...sceneImage, _type: "sceneImage" }; continue; }

    // Worldbooks (modules) — the snapshot truncates their sticky note at 300
    // chars and points here for the rest, so this lookup must exist.
    const worldbook = (world.worldbooks ?? []).find((w) => w.id === id);
    if (worldbook) { results[id] = { ...worldbook, _type: "worldbook" }; continue; }

    // Special IDs
    if (id === "settings") { results[id] = { ...world.settings, _type: "settings" }; continue; }
    results[id] = null;
  }

  return { results };
}

// ── Grep World (unified cross-entity search) ──

export type GrepScope = "customUI" | "entries" | "variables" | "behaviors" | "all";

export interface GrepMatch {
  /** Which entity type the match came from */
  entityType: "customUI" | "entry" | "variable" | "behavior";
  /** The entity's ID (for customUI scope: may be a rootComponent filename like "homepage.tsx") */
  entityId: string;
  /** Optional friendly name for display */
  entityName?: string;
  /** Which field of the entity matched (tsxCode / content / behaviorRules / description / name) */
  field: string;
  /** 1-indexed line number within the field's text */
  line: number;
  /** 1-indexed column of the match start */
  col: number;
  /** Formatted ±contextLines excerpt with line numbers; matching line prefixed with ">" */
  context: string;
}

export interface GrepWorldResult {
  query: string;
  scope: GrepScope;
  /** Entity ID filter, if one was applied */
  id?: string;
  matchCount: number;
  /** Whether the result was capped at MAX_MATCHES (more matches exist beyond the returned set) */
  truncated: boolean;
  matches: GrepMatch[];
  error?: string;
}

/** Internal: a text source to grep, with its entity origin for result attribution. */
interface GrepSource {
  entityType: GrepMatch["entityType"];
  entityId: string;
  entityName?: string;
  field: string;
  text: string;
}

function collectGrepSources(world: WorldDefinition, scope: GrepScope, idFilter?: string): GrepSource[] {
  const sources: GrepSource[] = [];
  const wantAll = scope === "all";

  if (wantAll || scope === "customUI") {
    for (const ui of world.customUI ?? []) {
      if (idFilter && ui.id !== idFilter) continue;
      sources.push({ entityType: "customUI", entityId: ui.id, entityName: ui.name, field: "tsxCode", text: ui.tsxCode ?? "" });
    }
    if (world.rootComponent) {
      const rc = world.rootComponent;
      // When idFilter is set, resolve aliases: rc.id or "root-component" → entry file; filename → that file.
      if (idFilter) {
        if (idFilter === rc.id || idFilter === "root-component") {
          sources.push({ entityType: "customUI", entityId: rc.entryFile, entityName: `${rc.name} / ${rc.entryFile}`, field: "tsxCode", text: rc.files[rc.entryFile] ?? "" });
        } else if (idFilter in rc.files) {
          sources.push({ entityType: "customUI", entityId: idFilter, entityName: `${rc.name} / ${idFilter}`, field: "tsxCode", text: rc.files[idFilter] ?? "" });
        }
      } else {
        for (const [filename, code] of Object.entries(rc.files)) {
          sources.push({ entityType: "customUI", entityId: filename, entityName: `${rc.name} / ${filename}`, field: "tsxCode", text: code });
        }
      }
    }
  }

  if (wantAll || scope === "entries") {
    for (const e of world.entries) {
      if (idFilter && e.id !== idFilter) continue;
      const content = (e as { content?: string }).content ?? "";
      if (content) sources.push({ entityType: "entry", entityId: e.id, entityName: (e as { name?: string }).name, field: "content", text: content });
    }
  }

  if (wantAll || scope === "variables") {
    for (const v of world.variables) {
      if (idFilter && v.id !== idFilter) continue;
      const rules = (v as { behaviorRules?: string }).behaviorRules;
      if (rules) sources.push({ entityType: "variable", entityId: v.id, entityName: (v as { name?: string }).name, field: "behaviorRules", text: rules });
      const desc = (v as { description?: string }).description;
      if (desc) sources.push({ entityType: "variable", entityId: v.id, entityName: (v as { name?: string }).name, field: "description", text: desc });
    }
  }

  if (wantAll || scope === "behaviors") {
    for (const r of world.reactions ?? []) {
      if (idFilter && r.id !== idFilter) continue;
      const desc = (r as { description?: string }).description;
      if (desc) sources.push({ entityType: "behavior", entityId: r.id, entityName: (r as { name?: string }).name, field: "description", text: desc });
    }
  }

  return sources;
}

/**
 * Grep across any scope of the world (TSX components, entry content, variable behaviorRules,
 * behavior descriptions). Returns each literal match with surrounding context lines, so the
 * agent can build an exact `old_code` for `edit_custom_ui` or locate a concept across many
 * entities without a per-file walk.
 *
 * Matches are literal (not regex), case-sensitive. Bounded at 20 matches total and 20 lines
 * of context per side to keep response size predictable.
 */
export function executeGrepWorld(
  world: WorldDefinition,
  params: {
    query: string;
    scope?: GrepScope;
    /** Restrict search to a specific entity by ID (works within any scope). */
    id?: string;
    context_lines?: number;
  },
): GrepWorldResult {
  const query = params.query ?? "";
  const scope: GrepScope = params.scope ?? "all";
  const contextLines = Math.min(Math.max(1, params.context_lines ?? 5), 20);
  const MAX_MATCHES = 20;

  if (!query) {
    return { query, scope, id: params.id, matchCount: 0, truncated: false, matches: [], error: "Empty query — provide a literal string to search for." };
  }

  const sources = collectGrepSources(world, scope, params.id);
  if (sources.length === 0) {
    return {
      query, scope, id: params.id, matchCount: 0, truncated: false, matches: [],
      error: params.id
        ? `No matching entity for id="${params.id}" in scope="${scope}". Check the inventory for valid IDs.`
        : `No searchable content in scope="${scope}".`,
    };
  }

  const matches: GrepMatch[] = [];
  let truncated = false;

  for (const src of sources) {
    if (truncated) break;
    const lines = src.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const col = lines[i]!.indexOf(query);
      if (col === -1) continue;

      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }

      const startLine = Math.max(0, i - contextLines);
      const endLine = Math.min(lines.length - 1, i + contextLines);
      const excerpt: string[] = [];
      for (let j = startLine; j <= endLine; j++) {
        const prefix = j === i ? ">" : " ";
        excerpt.push(`${prefix} ${(j + 1).toString().padStart(5)}: ${lines[j]}`);
      }

      matches.push({
        entityType: src.entityType,
        entityId: src.entityId,
        entityName: src.entityName,
        field: src.field,
        line: i + 1,
        col: col + 1,
        context: excerpt.join("\n"),
      });
    }
  }

  return { query, scope, id: params.id, matchCount: matches.length, truncated, matches };
}

// ── Validate World ──

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  entity: { type: string; id: string };
  message: string;
  /** Optional hint on how to fix */
  fix?: string;
}

export interface ValidateWorldResult {
  clean: boolean;
  errorCount: number;
  warningCount: number;
  issues: ValidationIssue[];
  /** Short summary for the LLM to read */
  summary: string;
}

/** Built-in macros that should NOT be treated as variable references. */
const BUILTIN_MACROS = new Set([
  "char", "user", "turnCount", "time", "date", "weekday",
  "isodate", "isotime", "idle", "lastMessage", "lastUserMessage",
  "lastCharMessage", "model", "trim",
]);

/** Macro-prefix tokens: these signal a parameterized macro (not a variable ref). */
const MACRO_PREFIXES = ["var:", "random::", "pick::", "roll::", "// "];

/** Extract macro tokens from entry content. Returns the inner text of each `{{...}}` match. */
function extractMacros(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}

/** Resolve a macro body to its implied variable reference, or null if it's a built-in / parameterized macro. */
function macroToVariableRef(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (BUILTIN_MACROS.has(trimmed)) return null;
  for (const prefix of MACRO_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      // {{var:foo}} explicitly names variable "foo"
      if (prefix === "var:") return trimmed.slice(prefix.length).trim() || null;
      return null;
    }
  }
  // Bare macro like {{hp}} — treat as implicit variable ref
  return trimmed;
}

/** Quick check: is the effect `path` a system path (starts with @) or a variable reference? */
function isSystemPath(path: string): boolean {
  return path.startsWith("@");
}

/**
 * Scan the world for structural issues. Does NOT mutate. Returns a report of
 * errors (definitely broken) and warnings (risky, possibly intentional).
 *
 * Checks:
 *  - Undefined variable refs in conditions (error)
 *  - Undefined variable refs in effect paths (error)
 *  - Undefined variable refs in behavior when.match (error)
 *  - Undefined variable refs in entry content macros (warning — could be a typo or dynamic)
 *  - Duplicate IDs across all entity types (error)
 *  - chat-history entries with no keywords and not alwaysSend + no conditions (error — never triggers)
 *  - Variables without behaviorRules (warning — AI won't update them)
 *  - state:changed / state:crossed behaviors with no maxFireCount AND no cooldownTurns (warning — can fire every turn)
 *  - Missing greeting (warning — world opens with no first message)
 */
export function executeValidateWorld(world: WorldDefinition, options?: { skipTsx?: boolean }): ValidateWorldResult {
  const issues: ValidationIssue[] = [];
  const variableIds = new Set(world.variables.map((v) => v.id));
  const entryIds = world.entries.map((e) => e.id);
  const behaviorIds = (world.reactions ?? []).map((r) => r.id);
  const ruleIds = world.rules.map((r) => r.id);
  const customUIIds = (world.customUI ?? []).map((c) => c.id);
  const audioIds = (world.audioTracks ?? []).map((a) => a.id);
  const sceneImageIds = (world.sceneImages ?? []).map((img) => img.id);

  // ── Duplicate-ID check (cross-type) ──
  const allIds: { id: string; type: string }[] = [
    ...entryIds.map((id) => ({ id, type: "entry" })),
    ...world.variables.map((v) => ({ id: v.id, type: "variable" })),
    ...behaviorIds.map((id) => ({ id, type: "behavior" })),
    ...ruleIds.map((id) => ({ id, type: "rule" })),
    ...customUIIds.map((id) => ({ id, type: "customUI" })),
    ...audioIds.map((id) => ({ id, type: "audio" })),
    ...sceneImageIds.map((id) => ({ id, type: "sceneImage" })),
  ];
  const seen = new Map<string, string>();
  for (const { id, type } of allIds) {
    if (!id) continue;
    const prev = seen.get(id);
    if (prev && prev !== type) {
      issues.push({
        severity: "error",
        code: "duplicate-id-cross-type",
        entity: { type, id },
        message: `ID "${id}" is used by both a ${prev} and a ${type}. Cross-type ID collisions break ID-based lookups.`,
        fix: "Rename one of the conflicting entities to a distinct kebab-case ID.",
      });
    }
    seen.set(id, type);
  }

  // ── Variables: missing behaviorRules ──
  for (const v of world.variables) {
    const rules = (v as { behaviorRules?: string }).behaviorRules ?? "";
    if (!rules.trim()) {
      issues.push({
        severity: "warning",
        code: "variable-no-behavior-rules",
        entity: { type: "variable", id: v.id },
        message: `Variable "${v.id}" has no behaviorRules. The gameplay AI has no guidance to update it, so it will remain at its default value.`,
        fix: "Add behaviorRules describing specific ranges, thresholds, and what triggers changes.",
      });
    }
  }

  // ── Entries: chat-history with no triggers ──
  for (const e of world.entries) {
    const section = (e as { section?: string }).section;
    const alwaysSend = (e as { alwaysSend?: boolean }).alwaysSend;
    const keywords = (e as { keywords?: string[] }).keywords ?? [];
    const conditions = (e as { conditions?: unknown[] }).conditions ?? [];
    if (section === "chat-history" && !alwaysSend && keywords.length === 0 && conditions.length === 0) {
      issues.push({
        severity: "error",
        code: "entry-no-triggers",
        entity: { type: "entry", id: e.id },
        message: `Entry "${e.id}" is in chat-history but has no keywords, no conditions, and alwaysSend is false. It will never be included in the prompt.`,
        fix: "Add keywords to trigger on text, conditions to trigger on state, or move to system-presets for always-sent content.",
      });
    }
  }

  // ── Entries: undefined macros in content ──
  for (const e of world.entries) {
    const content = (e as { content?: string }).content ?? "";
    if (!content) continue;
    const macros = extractMacros(content);
    for (const body of macros) {
      const ref = macroToVariableRef(body);
      if (!ref) continue;
      if (!variableIds.has(ref)) {
        issues.push({
          severity: "warning",
          code: "entry-undefined-macro",
          entity: { type: "entry", id: e.id },
          message: `Entry "${e.id}" uses macro {{${body}}} but no variable named "${ref}" exists. It will render as the literal text "{{${body}}}".`,
          fix: `Either create variable "${ref}", fix the macro spelling, or use a built-in like {{char}} / {{user}}.`,
        });
      }
    }
  }

  // ── Entries: condition variable refs ──
  for (const e of world.entries) {
    const conditions = ((e as { conditions?: Array<{ variableId?: string }> }).conditions) ?? [];
    for (const c of conditions) {
      if (c.variableId && !variableIds.has(c.variableId)) {
        issues.push({
          severity: "error",
          code: "entry-undefined-condition-ref",
          entity: { type: "entry", id: e.id },
          message: `Entry "${e.id}" has a condition on variable "${c.variableId}" which does not exist. The condition will silently evaluate to false and the entry will never trigger via that condition.`,
          fix: `Create variable "${c.variableId}" or correct the variableId in the entry's conditions.`,
        });
      }
    }
  }

  // ── Behaviors (reactions): when.match + conditions + effects ──
  for (const r of world.reactions ?? []) {
    const when = (r as { when?: { eventType?: string; match?: Record<string, { value?: unknown }> } }).when;
    // Check match.variableId for state:changed / state:crossed
    if (when?.match) {
      const vidMatch = when.match.variableId;
      if (vidMatch && typeof vidMatch.value === "string" && !variableIds.has(vidMatch.value)) {
        issues.push({
          severity: "error",
          code: "behavior-undefined-match-ref",
          entity: { type: "behavior", id: r.id },
          message: `Behavior "${r.id}" matches on variable "${vidMatch.value}" which does not exist. The behavior will never fire.`,
          fix: `Create variable "${vidMatch.value}" or correct the match.variableId.`,
        });
      }
    }

    // Conditions
    const conditions = ((r as { conditions?: Array<{ variableId?: string }> }).conditions) ?? [];
    for (const c of conditions) {
      if (c.variableId && !variableIds.has(c.variableId)) {
        issues.push({
          severity: "error",
          code: "behavior-undefined-condition-ref",
          entity: { type: "behavior", id: r.id },
          message: `Behavior "${r.id}" has a condition on variable "${c.variableId}" which does not exist.`,
          fix: `Create variable "${c.variableId}" or correct the variableId.`,
        });
      }
    }

    // Effects: for `set` type, if path doesn't start with @, it's a variable ref
    const effects = ((r as { then?: Array<{ type?: string; path?: string }> }).then) ?? [];
    for (const eff of effects) {
      if (eff.type === "set" && eff.path && !isSystemPath(eff.path)) {
        const rootVar = eff.path.split(".")[0]!;
        if (!variableIds.has(rootVar)) {
          issues.push({
            severity: "error",
            code: "behavior-undefined-effect-ref",
            entity: { type: "behavior", id: r.id },
            message: `Behavior "${r.id}" has an effect targeting variable "${rootVar}" (via path "${eff.path}") which does not exist.`,
            fix: `Create variable "${rootVar}" or correct the effect path. For system paths, use the @ prefix (e.g. @prompt.directive.X).`,
          });
        }
      }
    }

    // Self-loop risk: state:changed / state:crossed where an effect writes to the SAME
    // variable the trigger matches, and no maxFireCount or cooldown bounds the loop.
    // Ignore cases where the effect writes to a different variable or a system @path —
    // those can't re-trigger the same behavior. (Matches Tsubo sample's legit patterns.)
    const eventType = when?.eventType;
    const maxFire = (r as { maxFireCount?: number }).maxFireCount;
    const cooldown = (r as { cooldownTurns?: number }).cooldownTurns;
    if (eventType && (eventType === "state:changed" || eventType === "state:crossed") && !maxFire && !cooldown) {
      const triggerVar = when?.match?.variableId?.value;
      if (typeof triggerVar === "string") {
        const selfLoop = effects.some((eff) =>
          eff.type === "set" && typeof eff.path === "string" && !isSystemPath(eff.path) &&
          eff.path.split(".")[0] === triggerVar,
        );
        if (selfLoop) {
          issues.push({
            severity: "warning",
            code: "behavior-self-loop-risk",
            entity: { type: "behavior", id: r.id },
            message: `Behavior "${r.id}" triggers on "${eventType}" for variable "${triggerVar}" and its own effects write back to "${triggerVar}". Without maxFireCount or cooldownTurns, each write will re-trigger the behavior.`,
            fix: "Add maxFireCount (one-shot) or cooldownTurns (rate-limit), or change the effect to target a different variable / system path.",
          });
        }
      }
    }
  }

  // ── Inline base64 data URIs (asset bloat) ──
  // Delegates the regex + threshold to lib/asset-validation.ts so warnings and
  // hard-reject errors stay consistent. 200-char threshold skips placeholder SVG icons.
  for (const ui of world.customUI ?? []) {
    const match = scanTextForInlineDataUris(ui.tsxCode ?? "");
    if (match) {
      issues.push({
        severity: "warning",
        code: "inline-data-uri-in-tsx",
        entity: { type: "customUI", id: ui.id },
        message: `Custom UI "${ui.id}" contains ${match.count} inline base64 data URI(s) totaling ~${Math.round(match.totalBytes / 1024)}KB. Base64 inflates binary size by 33% and ships on every load; the write path now rejects new base64 but legacy content stays until migrated.`,
        fix: "Upload each embedded asset via the asset picker, then reference it as @asset:{assetId} and resolve at render time with useYumina().resolveAssetUrl(ref).",
      });
    }
  }

  if (world.rootComponent) {
    for (const [filename, code] of Object.entries(world.rootComponent.files)) {
      const match = scanTextForInlineDataUris(code);
      if (match) {
        issues.push({
          severity: "warning",
          code: "inline-data-uri-in-tsx",
          entity: { type: "customUI", id: filename },
          message: `Root component file "${filename}" contains ${match.count} inline base64 data URI(s) totaling ~${Math.round(match.totalBytes / 1024)}KB.`,
          fix: "Upload each embedded asset via the asset picker and replace the data URI with @asset:{assetId}.",
        });
      }
    }
  }

  for (const e of world.entries) {
    const content = (e as { content?: string }).content ?? "";
    const match = scanTextForInlineDataUris(content);
    if (match) {
      issues.push({
        severity: "warning",
        code: "inline-data-uri-in-entry",
        entity: { type: "entry", id: e.id },
        message: `Entry "${e.id}" content contains ${match.count} inline base64 data URI(s) totaling ~${Math.round(match.totalBytes / 1024)}KB. Every LLM call re-sends these bytes.`,
        fix: "Replace ![alt](data:...) markdown images with @asset:{assetId} refs (uploaded via asset picker).",
      });
    }
  }

  for (const img of world.sceneImages ?? []) {
    if ((img.url ?? "").startsWith("data:")) {
      issues.push({
        severity: "warning",
        code: "inline-data-uri-in-scene-image",
        entity: { type: "sceneImage", id: img.id },
        message: `Scene image "${img.id}" has a data: URI as its picture. Upload it as an asset and reference @asset:{id} so it streams from CDN instead of living in the world JSON.`,
        fix: "Upload the picture via the asset picker, then set url to '@asset:{assetId}'.",
      });
    }
  }

  for (const a of world.audioTracks ?? []) {
    const url = (a as { url?: string }).url ?? "";
    if (url.startsWith("data:")) {
      issues.push({
        severity: "warning",
        code: "inline-data-uri-in-audio",
        entity: { type: "audio", id: a.id },
        message: `Audio track "${a.id}" has a data: URI as its URL. Upload as an asset and reference with @asset:{id} so the binary streams from CDN instead of living in the world JSON.`,
        fix: "Upload the audio file via the asset picker, then set url to '@asset:{assetId}'.",
      });
    }
  }

  // ── Missing greeting ──
  const hasGreeting = world.entries.some((e) => (e as { role?: string }).role === "greeting");
  if (!hasGreeting) {
    issues.push({
      severity: "warning",
      code: "no-greeting",
      entity: { type: "world", id: world.id ?? "world" },
      message: "World has no greeting entry (role: \"greeting\"). Players will open to an empty first message.",
      fix: "Add an entry with role: \"greeting\" to set the opening scene.",
    });
  }

  // ── rootComponent TSX syntax errors (the read-spiral / unclosed-bracket class) ──
  // A single broken brace anywhere makes every edit_custom_ui to that file fail.
  // Reporting it here, WITH a code window, lets the agent locate and fix the break
  // by calling validate_world instead of re-reading a 4,500-line file.
  // Sucrase transform is synchronous and CPU-bound. validate_world runs in the
  // shared server event loop, so bound the work: skip pathological single files
  // (base64-embedded blobs) and cap cumulative bytes per call. Real worlds (largest
  // index.tsx ~435KB) stay well under the per-file cap; per-edit compileTsx still
  // syntax-checks any skipped file on every write, so nothing goes unchecked there.
  const MAX_VALIDATE_FILE_BYTES = 512 * 1024;
  let validateByteBudget = 2 * 1024 * 1024;
  const validateSource = (id: string, label: string, src: string) => {
    if (src.length > MAX_VALIDATE_FILE_BYTES || validateByteBudget <= 0) return;
    validateByteBudget -= src.length;
    for (const issue of validateTsx(src)) {
      issues.push({
        severity: "error",
        code: "tsx-syntax-error",
        entity: { type: "customUI", id },
        message: `${label} has a TSX syntax error.\n${formatTsxIssue(issue)}`,
        fix: `Fix the syntax at line ${issue.line} of ${id}, then re-validate. Use edit_custom_ui with old_code copied verbatim from the snippet above.`,
      });
    }
  };

  // skipTsx: the agent loop's auto-validate-after-write passes this. Per-edit
  // compileTsx already gates TSX syntax on every write, so we skip the CPU-bound
  // full re-scan there and run only the cheap structural checks above.
  if (!options?.skipTsx) {
    const rcFiles = (world as { rootComponent?: { files?: Record<string, unknown> } }).rootComponent?.files;
    if (rcFiles) {
      for (const [fname, src] of Object.entries(rcFiles)) {
        if (typeof src === "string") validateSource(fname, fname, src);
      }
    }
    // Legacy per-component customUI[] (pre-rootComponent worlds).
    for (const c of (world.customUI ?? []) as Array<{ id: string; tsxCode?: string }>) {
      if (typeof c.tsxCode === "string") validateSource(c.id, `customUI "${c.id}"`, c.tsxCode);
    }
  }

  // The automatic pass after every write only consumes structural errors.
  // Keep its skipTsx path cheap; UI writes already echo connection warnings in
  // their results, and an explicit validate_world performs the full graph scan.
  const unreachableFiles = options?.skipTsx ? [] : analyzeRootUiReachability(world.rootComponent).unreachableFiles;
  for (const filename of unreachableFiles) {
    issues.push({
      severity: "warning",
      code: "root-ui-unreachable-file",
      entity: { type: "customUI", id: filename },
      message: `File "${filename}" is not referenced from entry "${world.rootComponent!.entryFile}". Its code is not part of the entry's dependency graph; editing this file alone cannot change the rendered UI.`,
      fix: "If this component should appear, import it and mount it from the entry or an already connected component. Unused library files may be intentional. Also verify visibility and styles in the initial/closed state.",
    });
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  let summary: string;
  if (errorCount === 0 && warningCount === 0) summary = "World validates cleanly.";
  else summary = `${errorCount} error(s), ${warningCount} warning(s). ${issues.slice(0, 3).map((i) => `[${i.code}] ${i.message}`).join(" ")}${issues.length > 3 ? ` (+ ${issues.length - 3} more)` : ""}`;
  if (world.rootComponent) summary += " Static validation does not verify rendered visibility, interaction, or CSS in each UI state.";

  return {
    clean: errorCount === 0 && warningCount === 0,
    errorCount,
    warningCount,
    issues,
    summary,
  };
}

// ── Token Cost Analysis (on-demand) ──

/** Heavy keyword-lore pool (tokens) past which a single turn's worst-case
 *  injection is worth flagging. 25k is already ~2x a typical card's whole
 *  always-send footprint. */
const LORE_FLOOD_TOKEN_THRESHOLD = 25000;

export interface TokenCostReport {
  /** Keyword-triggered (chat-history, non-alwaysSend, enabled) entries. */
  keywordEntryCount: number;
  /** Total tokens across the whole keyword-lore pool. */
  keywordPoolTokens: number;
  /** Worst case lore injected in ONE turn = whole pool capped by the effective budget. */
  worstCaseInjection: number;
  /** Always-send entry tokens (what the editor footer DOES count). */
  alwaysSendTokens: number;
  /** Variable behaviorRules tokens (also counted by the footer). */
  behaviorRulesTokens: number;
  recursionDepth: number;
  budgetCap: number;
  budgetPercent: number;
  effectiveBudget: number;
  floodRisk: boolean;
  /** Advisory + fix, present only when floodRisk. */
  advisory?: string;
  fix?: string;
  summary: string;
}

/**
 * On-demand per-turn token cost analysis for the Studio build assistant.
 *
 * Deliberately NOT part of validate_world. validate_world is a high-frequency,
 * auto-executed correctness check (the assistant calls it after every write
 * batch); lorebook cost is a stable design/cost ADVISORY about a legitimate
 * configuration choice. Bundling the advisory into the validator made the
 * assistant re-report it and re-scan the whole keyword pool every turn. The
 * assistant calls this tool only when the creator asks why per-turn cost is high
 * (or right after building a lore-heavy card) — see system-prompt tools-guide.
 *
 * The keyword-lore pool is the per-turn cost blind spot: the editor footer /
 * buildPromptCostBreakdown count only always-send entries + variable rules, NOT
 * keyword-matched lore, which on lore-heavy cards is the dominant per-turn cost.
 * With no budget cap (default) ALL matched entries inject, and recursion>0 makes
 * triggered entries' own text trigger yet more entries — cascading into firing
 * most of the pool every turn.
 */
export function executeAnalyzeTokenCost(world: WorldDefinition): TokenCostReport {
  const s = (world.settings ?? {}) as Record<string, number | undefined>;
  const recursion = s.lorebookRecursionDepth ?? 0;
  const budgetCap = s.lorebookBudgetCap ?? 0;
  const budgetPercent = s.lorebookBudgetPercent ?? 100;
  const maxContext = s.maxContext ?? 200000;
  const percentBudget = Math.round((budgetPercent * maxContext) / 100);
  const effectiveBudget = budgetCap > 0 ? Math.min(budgetCap, percentBudget) : percentBudget;

  const keywordEntries = world.entries.filter((e) => {
    const en = (e as { enabled?: boolean }).enabled;
    const role = (e as { role?: string }).role;
    const alwaysSend = (e as { alwaysSend?: boolean }).alwaysSend;
    const keywords = (e as { keywords?: string[] }).keywords ?? [];
    return en !== false && role !== "greeting" && role !== "example" && !alwaysSend && keywords.length > 0;
  });
  const keywordPoolTokens = keywordEntries.reduce(
    (sum, e) => sum + estimateTokens((e as { content?: string }).content ?? ""),
    0
  );
  // Worst-case lore injected in one turn = whole pool, capped by the effective budget.
  const worstCaseInjection = Math.min(keywordPoolTokens, effectiveBudget);

  // The always-send footprint the editor footer DOES show, for contrast.
  const alwaysSendTokens = world.entries
    .filter((e) => (e as { enabled?: boolean }).enabled !== false && (e as { alwaysSend?: boolean }).alwaysSend)
    .reduce((sum, e) => sum + estimateTokens((e as { content?: string }).content ?? ""), 0);
  const behaviorRulesTokens = world.variables.reduce(
    (sum, v) => sum + estimateTokens((v as { behaviorRules?: string }).behaviorRules ?? ""),
    0
  );

  const floodRisk =
    keywordPoolTokens >= LORE_FLOOD_TOKEN_THRESHOLD && worstCaseInjection >= LORE_FLOOD_TOKEN_THRESHOLD;

  let advisory: string | undefined;
  let fix: string | undefined;
  if (floodRisk) {
    const capDesc = budgetCap > 0 ? `a ${budgetCap}-token cap` : "NO budget cap (lorebookBudgetCap=0)";
    const recursionClause = recursion > 0
      ? ` Recursion is ON (lorebookRecursionDepth=${recursion}), so triggered entries' own text triggers further entries — this typically fires most of the pool every turn, not just entries matched by the player's message.`
      : "";
    advisory =
      `This card has ${keywordEntries.length} keyword-triggered lore entries totaling ~${keywordPoolTokens} tokens, with ${capDesc}. ` +
      `A single turn can inject up to ~${worstCaseInjection} tokens of lore — far more than the editor's "per-turn" estimate, which counts only always-send entries and variable rules and HIDES keyword-matched lore.${recursionClause} ` +
      `This is usually why per-turn token cost stays high even after trimming the always-send prompt.`;
    fix =
      "In priority order: (1) set lorebookRecursionDepth to 0 unless chained reveals are essential; " +
      "(2) tighten keywords — fewer, more specific words, enable matchWholeWords for names that collide with common language, and add secondaryKeywords (AND_ANY) so broad words only fire with a co-occurring term; " +
      "(3) set lorebookBudgetCap (e.g. 20000-30000) as a safety ceiling so a turn can never inject the whole pool. The cap is a backstop, not a substitute for tight keywords (it drops lowest-priority matches arbitrarily).";
  }

  const baseSentTokens = alwaysSendTokens + behaviorRulesTokens;
  const summary = floodRisk
    ? `⚠ Lorebook flood risk: up to ~${worstCaseInjection} tokens of keyword lore per turn (pool ~${keywordPoolTokens} tokens across ${keywordEntries.length} entries), on top of ~${baseSentTokens} always-sent tokens.`
    : `Per-turn estimate: ~${baseSentTokens} always-sent tokens + up to ~${worstCaseInjection} tokens of keyword lore (pool ~${keywordPoolTokens} across ${keywordEntries.length} entries). No flood risk.`;

  return {
    keywordEntryCount: keywordEntries.length,
    keywordPoolTokens,
    worstCaseInjection,
    alwaysSendTokens,
    behaviorRulesTokens,
    recursionDepth: recursion,
    budgetCap,
    budgetPercent,
    effectiveBudget,
    floodRisk,
    advisory,
    fix,
    summary,
  };
}

// ── Apply Changes (Atomic) ──

/**
 * Apply a batch of SchemaChange operations atomically.
 * If any change fails validation, NONE are applied.
 * Returns the mutated world only on full success.
 */
export function executeApplyChanges(
  world: WorldDefinition,
  changes: SchemaChange[],
): ApplyChangesResult {
  // Deep clone so we don't mutate the input
  const draft: WorldDefinition = JSON.parse(JSON.stringify(world));
  const results: ChangeResult[] = [];
  let hasError = false;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    const result = applySingleChange(draft, change, i);
    results.push(result);
    if (result.status === "error") {
      hasError = true;
    }
  }

  // Atomic: if any change failed, return the ORIGINAL world (unchanged)
  if (hasError) {
    const errorSummary = results
      .filter((r) => r.status === "error")
      .map((r) => `Change ${r.index + 1} (${r.action} ${r.entityType} "${r.id}"): ${r.error}`)
      .join("\n");

    return {
      world, // Original, unchanged
      results,
      success: false,
      summary: `Validation failed — no changes applied. Errors:\n${errorSummary}\n\nFix the errors and try again with the corrected changes.`,
    };
  }

  const successSummary = results
    .map((r) => {
      // Cost echo per entry: the agent should feel each entry's weight as it writes.
      let sizeNote = "";
      if (r.entityType === "entry") {
        const e = draft.entries.find((x) => x.id === r.id);
        if (e?.content) sizeNote = ` ~${estimateTokens(e.content).toLocaleString()} tok`;
      }
      return `${r.action} ${r.entityType} "${r.id}": OK${sizeNote}${r.note ? ` (${r.note})` : ""}`;
    })
    .join("\n");

  // Cost echo for the whole lorebook: report the new always-send load whenever
  // entries changed, and warn when it crosses the health budget — the agent sees
  // the number grow write-by-write instead of discovering the bloat afterwards.
  let costEcho = "";
  if (results.some((r) => r.entityType === "entry")) {
    const health = computeLorebookHealth(draft);
    const over = health.alwaysTokens > LOREBOOK_BUDGETS.alwaysSendTokens;
    costEcho = `\nLorebook load: always-send ${health.alwaysCount} entries ≈ ${health.alwaysTokens.toLocaleString()} tok/turn${
      over
        ? ` ⚠ over the ${LOREBOOK_BUDGETS.alwaysSendTokens.toLocaleString()} budget — surface this to the creator; propose cuts, never delete without their approval`
        : ""
    }; total lorebook ≈ ${health.totalTokens.toLocaleString()} tok.`;
  }

  return {
    world: draft,
    results,
    success: true,
    summary: `All ${changes.length} changes applied successfully:\n${successSummary}${costEcho}`,
  };
}

// ── Single Change Application ──

function applySingleChange(
  draft: WorldDefinition,
  change: SchemaChange,
  index: number,
): ChangeResult {
  const id = change.id ?? (change.action === "create" ? crypto.randomUUID() : "");
  const data = change.data ?? {};

  try {
    switch (change.entityType) {
      case "entry":
        return applyEntryChange(draft, change.action, id, data, index);
      case "variable":
        return applyVariableChange(draft, change.action, id, data, index);
      case "behavior":
        return applyBehaviorChange(draft, change.action, id, data, index);
      case "rule":
        return applyRuleChange(draft, change.action, id, data, index);
      case "customUI":
        // Route edit_custom_ui (search-replace) vs write_custom_ui (full replace)
        if (data.old_code !== undefined && data.new_code !== undefined) {
          return applyEditCustomUI(draft, id, data, index);
        }
        return applyCustomUIChange(draft, change.action, id, data, index);
      case "audio":
        return applyAudioChange(draft, change.action, id, data, index);
      case "sceneImage":
        return applySceneImageChange(draft, change.action, id, data, index);
      case "worldbook":
        return applyWorldbookChange(draft, change.action, id, data, index);
      case "loreBinding":
        return applyLoreBindingChange(draft, change.action, id, data, index);
      case "settings":
        return applySettingsChange(draft, data, index);
      case "uiKnobs":
        return applyUiKnobsChange(draft, data, index);
      case "uiKnobGroups":
        return applyUiKnobGroupsChange(draft, data, index);
      case "uiDoc":
        return applyUiDocChange(draft, data, index);
      default:
        return { index, action: change.action, entityType: change.entityType, id, status: "error", error: `Unknown entity type: ${change.entityType}` };
    }
  } catch (e) {
    return { index, action: change.action, entityType: change.entityType, id, status: "error", error: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ── Entry CRUD ──

/** Auto-create an entryFolder when an entry references a folderId that doesn't
 *  exist yet. Without this, the AI can mint orphan folderIds and the editor UI
 *  silently hides those entries (header count > 0, list empty). */
function ensureFolderExists(
  draft: WorldDefinition,
  folderId: string,
  section: WorldEntry["section"],
  worldbookId?: string,
): string {
  if (!draft.entryFolders) draft.entryFolders = [];
  const existing = draft.entryFolders.find((f) => f.id === folderId);
  if (
    existing &&
    existing.section === section &&
    (existing.worldbookId ?? undefined) === (worldbookId ?? undefined)
  ) {
    return folderId;
  }

  // The requested id already belongs to another book/section. Mint a scoped
  // id instead of reusing the shared folder and recreating the leakage bug.
  let resolvedId = folderId;
  if (existing) {
    const scope = worldbookId ?? "core";
    const stem = `${folderId}--${scope}--${section}`;
    resolvedId = stem;
    let suffix = 2;
    while (draft.entryFolders.some((folder) => folder.id === resolvedId)) {
      resolvedId = `${stem}-${suffix++}`;
    }
  }
  const maxOrder = draft.entryFolders
    .filter(
      (f) =>
        f.section === section &&
        (f.worldbookId ?? undefined) === (worldbookId ?? undefined),
    )
    .reduce((m, f) => Math.max(m, f.order ?? -1), -1);
  draft.entryFolders.push({
    id: resolvedId,
    name: existing?.name ?? folderId,
    section,
    order: maxOrder + 1,
    worldbookId,
  });
  return resolvedId;
}

function applyEntryChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "entry", id };
  const badVoice = invalidVoiceError("write_entry", id, "voice", data.voice);
  if (badVoice) return { ...base, status: "error", error: badVoice };

  // Model output is untrusted even when the outer tool call is valid JSON.
  // Validate before create/upsert/update so malformed text never reaches lore.
  if ((action === "create" || action === "update") && data.content !== undefined && typeof data.content !== "string") {
    return { ...base, status: "error", error: "Entry content must be a string. Send plain text in the content field." };
  }

  if (action === "create") {
    // Duplicate check
    const existing = draft.entries.find((e) => e.id === id);
    if (existing) {
      const previousWorldbookId = existing.worldbookId;
      applyEntryUpdates(existing, data);
      if (
        data.worldbookId !== undefined &&
        data.folderId === undefined &&
        (previousWorldbookId ?? undefined) !== (existing.worldbookId ?? undefined)
      ) {
        existing.folderId = undefined;
      }
      if (existing.folderId) {
        existing.folderId = ensureFolderExists(
          draft,
          existing.folderId,
          existing.section,
          existing.worldbookId,
        );
      }
      return { ...base, id, status: "success" };
    }

    const section = (data.section as WorldEntry["section"]) ?? "system-presets";
    const defaults = deriveSectionDefaults(section);

    // Auto-position
    let position = data.position as number | undefined;
    if (position === undefined) {
      const sectionEntries = draft.entries.filter((e) => e.section === section);
      const maxPos = sectionEntries.reduce((max, e) => Math.max(max, e.position ?? 0), -1);
      position = maxPos + 1;
    }

    const newEntry: WorldEntry = {
      id,
      name: (data.name as string) ?? "New Entry",
      content: (data.content as string) ?? "",
      role: (data.role as WorldEntry["role"]) ?? "custom",
      portrait: typeof data.portrait === "string" ? data.portrait : undefined,
      voice: voiceArg(data.voice),
      alwaysSend: (data.alwaysSend as boolean) ?? defaults.alwaysSend,
      keywords: toStringArray(data.keywords),
      conditions: mapConditions(data.conditions),
      conditionLogic: (data.conditionLogic as "all" | "any") ?? "all",
      enabled: data.enabled !== false,
      depth: (data.depth as number) ?? defaults.depth,
      matchWholeWords: (data.matchWholeWords as boolean) ?? false,
      secondaryKeywords: toStringArray(data.secondaryKeywords),
      secondaryKeywordLogic: (data.secondaryKeywordLogic as "AND_ANY" | "AND_ALL" | "NOT_ANY" | "NOT_ALL") ?? "AND_ANY",
      preventRecursion: (data.preventRecursion as boolean) ?? false,
      excludeRecursion: (data.excludeRecursion as boolean) ?? false,
      position,
      section,
      tags: toStringArray(data.tags),
      folderId: data.folderId as string | undefined,
      apiRole: data.apiRole as WorldEntry["apiRole"],
      worldbookId: normalizeWorldbookId(data.worldbookId),
      audience: data.audience as WorldEntry["audience"],
      initialVariables: toInitialVariables(data.initialVariables),
    };

    // Variable-bound entries never use always-send — conditions gate them.
    // Without this, "create entry with conditions" in a system-presets section
    // is born as alwaysSend=true and injects every turn, conditions dead.
    if (isVariableBoundEntry(newEntry)) newEntry.alwaysSend = false;

    if (newEntry.folderId) {
      newEntry.folderId = ensureFolderExists(
        draft,
        newEntry.folderId,
        newEntry.section,
        newEntry.worldbookId,
      );
    }
    draft.entries.push(newEntry);
    return { ...base, id, status: "success" };
  }

  if (action === "update") {
    const entry = draft.entries.find((e) => e.id === id);
    if (!entry) return { ...base, status: "error", error: `Entry not found: "${id}".${suggestSimilarIds(id, draft.entries.map((e) => e.id))}` };
    const previousWorldbookId = entry.worldbookId;
    applyEntryUpdates(entry, data);
    if (
      data.worldbookId !== undefined &&
      data.folderId === undefined &&
      (previousWorldbookId ?? undefined) !== (entry.worldbookId ?? undefined)
    ) {
      entry.folderId = undefined;
    }
    if (entry.folderId) {
      entry.folderId = ensureFolderExists(
        draft,
        entry.folderId,
        entry.section,
        entry.worldbookId,
      );
    }
    return { ...base, status: "success" };
  }

  if (action === "delete") {
    const idx = draft.entries.findIndex((e) => e.id === id);
    if (idx === -1) return { ...base, status: "error", error: `Entry not found: "${id}".${suggestSimilarIds(id, draft.entries.map((e) => e.id))}` };
    draft.entries.splice(idx, 1);
    return { ...base, status: "success" };
  }

  return { ...base, status: "error", error: `Unknown action: ${action}` };
}

function applyEntryUpdates(entry: WorldEntry, data: Record<string, unknown>): void {
  // Apply section FIRST so its defaults can be overridden by explicit fields below.
  // ForEntry variant: a variable-bound entry keeps alwaysSend=false — section
  // defaults must not resurrect always-send on a condition-gated entry.
  if (data.section !== undefined) {
    entry.section = data.section as WorldEntry["section"];
    const defaults = deriveSectionDefaultsForEntry(entry, entry.section);
    entry.alwaysSend = defaults.alwaysSend;
    if (defaults.depth !== undefined) entry.depth = defaults.depth;
  }
  if (data.name !== undefined) entry.name = data.name as string;
  if (data.content !== undefined) entry.content = data.content as string;
  if (data.role !== undefined) entry.role = data.role as WorldEntry["role"];
  if (typeof data.portrait === "string") entry.portrait = data.portrait;
  if (typeof data.voice === "string") entry.voice = voiceArg(data.voice);
  if (data.keywords !== undefined) entry.keywords = toStringArray(data.keywords);
  if (data.conditions !== undefined) entry.conditions = mapConditions(data.conditions);
  if (data.conditionLogic !== undefined) entry.conditionLogic = data.conditionLogic as "all" | "any";
  if (data.enabled !== undefined) entry.enabled = data.enabled as boolean;
  if (data.depth !== undefined) entry.depth = data.depth as number;
  if (data.alwaysSend !== undefined) entry.alwaysSend = data.alwaysSend as boolean;
  if (data.apiRole !== undefined) entry.apiRole = data.apiRole as WorldEntry["apiRole"];
  if (data.tags !== undefined) entry.tags = toStringArray(data.tags);
  if (data.matchWholeWords !== undefined) entry.matchWholeWords = data.matchWholeWords as boolean;
  if (data.secondaryKeywords !== undefined) entry.secondaryKeywords = toStringArray(data.secondaryKeywords);
  if (data.secondaryKeywordLogic !== undefined) entry.secondaryKeywordLogic = data.secondaryKeywordLogic as "AND_ANY" | "AND_ALL" | "NOT_ANY" | "NOT_ALL";
  if (data.preventRecursion !== undefined) entry.preventRecursion = data.preventRecursion as boolean;
  if (data.excludeRecursion !== undefined) entry.excludeRecursion = data.excludeRecursion as boolean;
  if (data.folderId !== undefined) entry.folderId = data.folderId as string;
  if (data.position !== undefined) entry.position = data.position as number;
  if (data.worldbookId !== undefined) entry.worldbookId = normalizeWorldbookId(data.worldbookId);
  if (data.audience !== undefined) entry.audience = data.audience as WorldEntry["audience"];
  if (data.initialVariables !== undefined) entry.initialVariables = toInitialVariables(data.initialVariables);
  // Final normalization — runs AFTER all fields so it sees the post-update
  // shape (e.g. section + conditions changed in the same tool call). A
  // variable-bound entry never uses always-send; conditions gate it.
  if (isVariableBoundEntry(entry) && entry.alwaysSend) entry.alwaysSend = false;
}

// ── Variable CRUD ──

/** Type names the LLM invents that map cleanly onto a real one. */
const TYPE_ALIASES: Record<string, Variable["type"]> = {
  text: "string", str: "string",
  int: "number", integer: "number", float: "number",
  bool: "boolean",
  array: "json", list: "json", object: "json",
};

function normalizeVariableType(raw: unknown): Variable["type"] | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "number" || t === "string" || t === "boolean" || t === "json") return t;
  return TYPE_ALIASES[t];
}

/**
 * Last resort when the model omits `type` entirely: read it off the default
 * rather than assuming number, which would flatten an untyped `[]` list to 0.
 */
function inferVariableType(raw: unknown): Variable["type"] {
  if (typeof raw === "boolean") return "boolean";
  if (typeof raw === "number") return "number";
  if (raw !== null && typeof raw === "object") return "json";
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "true" || s === "false") return "boolean";
    if (s.startsWith("[") || s.startsWith("{")) return "json";
    if (s !== "" && Number.isFinite(Number(s))) return "number";
    return "string";
  }
  return "number";
}

/**
 * Force `defaultValue` to match the declared `type`.
 *
 * Tool arguments are free-form JSON, and models overwhelmingly send the default
 * as a *string* regardless of type — `"0"` for a number, `"false"` for a boolean,
 * `"[]"` for json (511 of 836 write_variable calls in a 400-run sample). Nothing
 * downstream coerces, so the wrong-typed value lands in world.variables and then
 * in session state, where GameStateManager silently drops every directive against
 * it: `+`/`-` no-op on a string, `toggle` no-op on "false", `push`/`merge`/dot-path
 * no-op on "[]". The creator sees a stat that never moves and no error anywhere.
 * Only a whole-value `set` gets through — which is why the bug looks intermittent
 * and "heals" mid-session, then returns on the next session (state re-hydrates
 * from this default). See the manual editor, which JSON.parses before saving and
 * so never produces these.
 */
function coerceDefaultValue(type: Variable["type"], raw: unknown): Variable["defaultValue"] {
  switch (type) {
    case "number": {
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "boolean") return raw ? 1 : 0;
      if (typeof raw === "string") {
        const n = Number(raw.trim());
        if (raw.trim() !== "" && Number.isFinite(n)) return n;
      }
      // Models sometimes wrap the scalar: defaultValue: [85] for a number var.
      // Unwrap rather than discarding the value.
      if (Array.isArray(raw) && raw.length === 1) {
        const inner = raw[0];
        if (typeof inner === "number" && Number.isFinite(inner)) return inner;
        if (typeof inner === "string" && inner.trim() !== "" && Number.isFinite(Number(inner))) return Number(inner);
      }
      return 0;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (s === "true" || s === "1" || s === "yes") return true;
        if (s === "false" || s === "0" || s === "no" || s === "") return false;
      }
      return false;
    }
    case "json": {
      if (raw !== null && typeof raw === "object") return raw as Variable["defaultValue"];
      if (typeof raw === "string") {
        const s = raw.trim();
        if (s === "") return {};
        try {
          const parsed: unknown = JSON.parse(s);
          // A parsed scalar is still not a json container — fall through to {}.
          if (parsed !== null && typeof parsed === "object") return parsed as Variable["defaultValue"];
        } catch { /* not JSON — fall through */ }
      }
      return {};
    }
    case "string":
      if (typeof raw === "string") return raw;
      if (raw === null || raw === undefined) return "";
      if (typeof raw === "object") return JSON.stringify(raw);
      return String(raw);
  }
}

/** Accept only the three valid AI-access tiers; anything else → undefined (= "write"). */
function normalizeAiAccess(raw: unknown): Variable["aiAccess"] {
  return raw === "write" || raw === "read" || raw === "none" ? raw : undefined;
}

/** Normalize a model-supplied activation object into a valid VariableActivation.
 *  Invalid shapes → undefined (= always), so a malformed call can't wedge a
 *  variable into an unreachable state. */
function normalizeVariableActivation(raw: unknown): VariableActivation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const mode = obj.mode;
  if (mode === "always" || mode === "manual") return { mode };
  if (mode === "conditions") {
    return {
      mode,
      conditions: mapConditions(obj.conditions),
      conditionLogic: obj.conditionLogic === "any" ? "any" : "all",
    };
  }
  if (mode === "greeting") {
    const greetingIds = Array.isArray(obj.greetingIds)
      ? obj.greetingIds.filter((x): x is string => typeof x === "string")
      : [];
    return { mode, greetingIds };
  }
  return undefined;
}

function applyVariableChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "variable", id };

  if (action === "create") {
    const existing = draft.variables.find((v) => v.id === id);
    if (existing) {
      applyVariableUpdates(existing, data);
      return { ...base, status: "success" };
    }

    const varType = normalizeVariableType(data.type) ?? inferVariableType(data.defaultValue);
    const newVar: Variable = {
      id,
      name: (data.name as string) ?? "New Variable",
      type: varType,
      defaultValue: coerceDefaultValue(varType, data.defaultValue),
      description: data.description as string | undefined,
      min: data.min as number | undefined,
      max: data.max as number | undefined,
      behaviorRules: data.behaviorRules as string | undefined,
      scope: data.scope as Variable["scope"] | undefined,
      internal: data.internal as boolean | undefined,
      aiAccess: normalizeAiAccess(data.aiAccess),
      ...(typeof data.formula === "string" && data.formula.trim() ? { formula: data.formula.slice(0, 1000) } : {}),
      ...(data.persist === "player" ? { persist: "player" as const } : {}),
      activation: normalizeVariableActivation(data.activation),
      enabled: typeof data.enabled === "boolean" ? data.enabled : undefined,
      worldbookId: normalizeWorldbookId(data.worldbookId),
      ...preciseFields(data),
    };
    // Precise tracking is on for a new variable unless the assistant said
    // otherwise — the same default the editor gives a variable it makes.
    draft.variables.push(withPreciseTrackingDefault(newVar));
    return { ...base, status: "success" };
  }

  if (action === "update") {
    const variable = draft.variables.find((v) => v.id === id);
    if (!variable) return { ...base, status: "error", error: `Variable not found: "${id}".${suggestSimilarIds(id, draft.variables.map((v) => v.id))}` };
    applyVariableUpdates(variable, data);
    return { ...base, status: "success" };
  }

  if (action === "delete") {
    const idx = draft.variables.findIndex((v) => v.id === id);
    if (idx === -1) return { ...base, status: "error", error: `Variable not found: ${id}` };
    draft.variables.splice(idx, 1);
    return { ...base, status: "success" };
  }

  return { ...base, status: "error", error: `Unknown action: ${action}` };
}

function applyVariableUpdates(variable: Variable, data: Record<string, unknown>): void {
  if (data.name !== undefined) variable.name = data.name as string;
  // Type must land before the default so the default is coerced against the new
  // type; a type change with no new default re-coerces the existing one.
  if (data.type !== undefined) variable.type = normalizeVariableType(data.type) ?? variable.type;
  if (data.defaultValue !== undefined) {
    variable.defaultValue = coerceDefaultValue(variable.type, data.defaultValue);
  } else if (data.type !== undefined) {
    variable.defaultValue = coerceDefaultValue(variable.type, variable.defaultValue);
  }
  if (data.description !== undefined) variable.description = data.description as string;
  if (data.min !== undefined) variable.min = data.min as number;
  if (data.max !== undefined) variable.max = data.max as number;
  if (data.behaviorRules !== undefined) variable.behaviorRules = data.behaviorRules as string;
  if (data.scope !== undefined) variable.scope = data.scope as Variable["scope"];
  if (data.aiAccess !== undefined) variable.aiAccess = normalizeAiAccess(data.aiAccess);
  if (data.persist !== undefined) variable.persist = data.persist === "player" ? "player" : undefined;
  if (data.formula !== undefined) variable.formula = typeof data.formula === "string" && data.formula.trim() ? data.formula.slice(0, 1000) : undefined;
  if (data.activation !== undefined) variable.activation = normalizeVariableActivation(data.activation);
  if (data.enabled !== undefined) variable.enabled = typeof data.enabled === "boolean" ? data.enabled : undefined;
  if (data.worldbookId !== undefined) variable.worldbookId = normalizeWorldbookId(data.worldbookId);
  const precise = preciseFields(data);
  for (const key of ["options", "precise", "deltaDown", "deltaUp"] as const) {
    if (key in precise) (variable as unknown as Record<string, unknown>)[key] = precise[key];
  }
}

/** The precise-tracking fields a write_variable call carried, validated:
 *  `options` a list of non-empty strings, deltas whole numbers ≥ 0. */
function preciseFields(data: Record<string, unknown>): Partial<Pick<Variable, "options" | "precise" | "deltaDown" | "deltaUp">> {
  const out: Partial<Pick<Variable, "options" | "precise" | "deltaDown" | "deltaUp">> = {};
  if (Array.isArray(data.options)) {
    const options = [...new Set(data.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim()))];
    out.options = options.length > 0 ? options : undefined;
  }
  if (data.precise === true) out.precise = true;
  if (data.precise === false) out.precise = false;
  const delta = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined);
  if (delta(data.deltaDown) !== undefined) out.deltaDown = delta(data.deltaDown);
  if (delta(data.deltaUp) !== undefined) out.deltaUp = delta(data.deltaUp);
  return out;
}

// ── Behavior/Reaction CRUD ──

function applyBehaviorChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "behavior", id };
  if (!draft.reactions) draft.reactions = [];

  if (action === "create") {
    const existing = draft.reactions.find((r) => r.id === id);
    if (existing) {
      applyBehaviorUpdates(existing, data);
      return { ...base, status: "success" };
    }

    const when = mapEventPattern((data.when ?? { eventType: "state:changed" }) as Record<string, unknown>);
    const conditions = mapConditions(data.conditions);
    const effects = mapReactionEffects((data.then ?? []) as Array<Record<string, unknown>>);

    const newBehavior: Reaction = {
      id,
      name: (data.name as string) ?? "New Behavior",
      description: data.description as string | undefined,
      when,
      conditions,
      conditionLogic: (data.conditionLogic as "all" | "any") ?? "all",
      then: effects,
      priority: (data.priority as number) ?? 0,
      cooldownTurns: data.cooldownTurns as number | undefined,
      maxFireCount: data.maxFireCount as number | undefined,
      chance: data.chance as number | undefined,
      enabled: data.enabled !== false,
      worldbookId: normalizeWorldbookId(data.worldbookId),
      ...(typeof data.elseMessage === "string" && data.elseMessage.trim() ? { elseMessage: data.elseMessage.slice(0, 500) } : {}),
      ...(typeof data.code === "string" && data.code.trim() ? { code: data.code.slice(0, 20000) } : {}),
    };
    draft.reactions.push(newBehavior);
    return { ...base, status: "success" };
  }

  if (action === "update") {
    const behavior = draft.reactions.find((r) => r.id === id);
    if (!behavior) return { ...base, status: "error", error: `Behavior not found: "${id}".${suggestSimilarIds(id, (draft.reactions ?? []).map((r) => r.id))}` };
    applyBehaviorUpdates(behavior, data);
    return { ...base, status: "success" };
  }

  if (action === "delete") {
    const idx = draft.reactions.findIndex((r) => r.id === id);
    if (idx === -1) return { ...base, status: "error", error: `Behavior not found: ${id}` };
    draft.reactions.splice(idx, 1);
    return { ...base, status: "success" };
  }

  return { ...base, status: "error", error: `Unknown action: ${action}` };
}

function applyBehaviorUpdates(behavior: Reaction, data: Record<string, unknown>): void {
  if (data.name !== undefined) behavior.name = data.name as string;
  if (data.description !== undefined) behavior.description = data.description as string;
  if (data.when !== undefined) behavior.when = mapEventPattern(data.when as Record<string, unknown>);
  if (data.conditions !== undefined) behavior.conditions = mapConditions(data.conditions);
  if (data.conditionLogic !== undefined) behavior.conditionLogic = data.conditionLogic as "all" | "any";
  if (data.then !== undefined) behavior.then = mapReactionEffects(data.then as Array<Record<string, unknown>>);
  if (data.priority !== undefined) behavior.priority = data.priority as number;
  if (data.cooldownTurns !== undefined) behavior.cooldownTurns = data.cooldownTurns as number;
  if (data.maxFireCount !== undefined) behavior.maxFireCount = data.maxFireCount as number;
  if (data.chance !== undefined) behavior.chance = data.chance as number;
  if (data.enabled !== undefined) behavior.enabled = data.enabled as boolean;
  if (data.worldbookId !== undefined) behavior.worldbookId = normalizeWorldbookId(data.worldbookId);
  if (data.elseMessage !== undefined) behavior.elseMessage = typeof data.elseMessage === "string" && data.elseMessage.trim() ? data.elseMessage.slice(0, 500) : undefined;
  if (data.custom !== undefined) behavior.custom = data.custom === true ? true : undefined;
  if (data.code !== undefined) behavior.code = typeof data.code === "string" && data.code.trim() ? data.code.slice(0, 20000) : undefined;
}

// ── Rule CRUD ──

function applyRuleChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "rule", id };

  if (action === "create") {
    const existing = draft.rules.find((r) => r.id === id);
    if (existing) {
      applyRuleUpdates(existing, data);
      return { ...base, status: "success" };
    }

    const trigger = mapTrigger((data.trigger ?? { type: "state-change" }) as Record<string, unknown>);
    const conditions = mapConditions(data.conditions);
    const actions = ((data.actions ?? []) as Array<Record<string, unknown>>).map(mapRuleAction);

    const newRule: Rule = {
      id,
      name: (data.name as string) ?? "New Rule",
      description: data.description as string | undefined,
      trigger: trigger as unknown as Rule["trigger"],
      conditions,
      conditionLogic: (data.conditionLogic as "all" | "any") ?? "all",
      actions: actions as unknown as Rule["actions"],
      priority: (data.priority as number) ?? 0,
      cooldownTurns: data.cooldownTurns as number | undefined,
      maxFireCount: data.maxFireCount as number | undefined,
      enabled: data.enabled !== false,
    };
    draft.rules.push(newRule);
    return { ...base, status: "success" };
  }

  if (action === "update") {
    const rule = draft.rules.find((r) => r.id === id);
    if (!rule) return { ...base, status: "error", error: `Rule not found: ${id}` };
    applyRuleUpdates(rule, data);
    return { ...base, status: "success" };
  }

  if (action === "delete") {
    const idx = draft.rules.findIndex((r) => r.id === id);
    if (idx === -1) return { ...base, status: "error", error: `Rule not found: ${id}` };
    draft.rules.splice(idx, 1);
    return { ...base, status: "success" };
  }

  return { ...base, status: "error", error: `Unknown action: ${action}` };
}

function applyRuleUpdates(rule: Rule, data: Record<string, unknown>): void {
  if (data.name !== undefined) rule.name = data.name as string;
  if (data.description !== undefined) rule.description = data.description as string;
  if (data.trigger !== undefined) rule.trigger = mapTrigger(data.trigger as Record<string, unknown>) as unknown as Rule["trigger"];
  if (data.conditions !== undefined) rule.conditions = mapConditions(data.conditions);
  if (data.conditionLogic !== undefined) rule.conditionLogic = data.conditionLogic as "all" | "any";
  if (data.actions !== undefined) rule.actions = ((data.actions as Array<Record<string, unknown>>).map(mapRuleAction)) as unknown as Rule["actions"];
  if (data.priority !== undefined) rule.priority = data.priority as number;
  if (data.cooldownTurns !== undefined) rule.cooldownTurns = data.cooldownTurns as number;
  if (data.maxFireCount !== undefined) rule.maxFireCount = data.maxFireCount as number;
  if (data.enabled !== undefined) rule.enabled = data.enabled as boolean;
}

// ── CustomUI CRUD ──

/** Reject writes that contain inline base64 data URIs (images, audio, video, font).
 *  Delegates to the shared helper in lib/asset-validation.ts so the agent path
 *  and the editor PATCH /worlds path share one source of truth. */
const assertNoInlineDataUris = assertNoInlineDataUrisShared;

function applyCustomUIChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  // migrateWorldDefinition runs on every load (sessions.ts, messages.ts,
  // agent.ts), so rootComponent is guaranteed by the time a write reaches
  // here. If it's somehow missing (e.g. brand-new world before first save),
  // ensureRootComponent creates a default.
  ensureRootComponent(draft);
  return applyRootComponentWrite(draft, action, id, data, index);
}

/** Stamp a default rootComponent on worlds that somehow arrived without one.
 *  The migrator guarantees this for every loaded world; this is defense-in-depth
 *  for newly-minted drafts that haven't gone through migrateWorldDefinition yet. */
function ensureRootComponent(draft: WorldDefinition): void {
  if (draft.rootComponent) return;
  draft.rootComponent = {
    id: (draft.id ?? "world") + ":root",
    name: "Root",
    entryFile: "index.tsx",
    files: {
      "index.tsx": "export default function App() { return React.createElement(Chat); }\n",
    },
    updatedAt: new Date().toISOString(),
  };
  draft.customUI = [];
}

// ── Root Component Write ──
// Transparently handles write_custom_ui calls for worlds with rootComponent.

function applyRootComponentWrite(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "customUI", id };

  if (action === "delete") {
    if (!draft.rootComponent) {
      return { ...base, status: "error", error: "No root component to reset" };
    }

    // A card built in the visual editor: resetting the root would drop the
    // preserved base and the next save would recompile the document anyway.
    if (draft.uiDoc) {
      const target = id in draft.rootComponent.files ? id : draft.rootComponent.entryFile;
      const isBase = target === draft.uiDoc.base?.file;
      const owned = uiDocOwnedFileError(draft, target, "delete");
      if (owned || isBase || !(id in draft.rootComponent.files)) {
        return { ...base, status: "error", error: owned ?? `Refused to delete "${target}": it is this card's preserved frontend (the interface document's base layer). To remove parts of the interface use edit_ui_doc remove_part; to drop the whole visual interface, ask the creator first.` };
      }
    }

    // If id is a sub-file (not the entry file), delete just that file
    const isSubFile = id.includes(".") && id in draft.rootComponent.files && id !== draft.rootComponent.entryFile;
    if (isSubFile) {
      delete draft.rootComponent.files[id];
      draft.rootComponent.updatedAt = new Date().toISOString();
      return { ...base, status: "success", note: `Deleted file "${id}" from root component` };
    }

    // Deleting rootComponent itself or entry file → reset to default Chat stub
    const rcId = draft.rootComponent.id;
    draft.rootComponent.files = {
      [draft.rootComponent.entryFile]: 'export default function MyWorld() {\n  return <Chat />;\n}',
    };
    draft.rootComponent.updatedAt = new Date().toISOString();
    return { ...base, id: rcId, status: "success", note: "Reset root component to default <Chat /> (worlds with rootComponent always retain it)" };
  }

  // TSX compilation check
  const tsxCode = data.tsxCode as string | undefined;
  if (tsxCode) {
    const assetErr = assertNoInlineDataUris(tsxCode, `write_custom_ui "${id}" tsxCode (root component)`);
    if (assetErr) return { ...base, status: "error", error: assetErr };
    const compileErr = compileTsx(tsxCode);
    if (compileErr) return { ...base, status: "error", error: `TSX compile error: ${compileErr}` };
  }

  // Ensure rootComponent exists (defensive — normally created by editor)
  if (!draft.rootComponent) {
    draft.rootComponent = {
      id: crypto.randomUUID(),
      name: "World Component",
      entryFile: "index.tsx",
      files: { "index.tsx": "" },
      updatedAt: new Date().toISOString(),
    };
  }

  // Determine target file: if id looks like a filename in the virtual FS, write to that file.
  // Otherwise write to the entry file (default behavior).
  const isFilename = id.includes(".");
  const targetFile = (isFilename && id in draft.rootComponent.files)
    ? id                              // existing file like "homepage.tsx"
    : isFilename && id.endsWith(".tsx")
      ? id                            // new file like "helpers.tsx" — will be created
      : draft.rootComponent.entryFile; // default: write to entry file

  // Never let a code write land in a file the interface document regenerates:
  // the editor's next save would overwrite it without a trace.
  const ownedErr = uiDocOwnedFileError(draft, targetFile, "write");
  if (ownedErr) return { ...base, id: targetFile, status: "error", error: ownedErr };
  if (tsxCode !== undefined) {
    draft.rootComponent.files[targetFile] = tsxCode;
  }
  if (data.name !== undefined) {
    draft.rootComponent.name = data.name as string;
  }
  draft.rootComponent.updatedAt = new Date().toISOString();

  const fileNote = targetFile === draft.rootComponent.entryFile
    ? `Updated root component entry file (${targetFile})`
    : `Updated root component file: ${targetFile}`;

  // Return rootComponent's actual ID so the agent can reference it for future reads
  return { ...base, id: targetFile, status: "success", note: fileNote + rootUiConnectionNote(draft.rootComponent, targetFile) };
}

// ── Edit Custom UI (Search-Replace) ──
// CoreCoder/Claude Code pattern: deterministic exact-match search-replace.
// old_code must appear exactly once. Much more token-efficient than full rewrite.

function applyEditCustomUI(draft: WorldDefinition, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action: "edit", entityType: "customUI", id };
  const oldCode = data.old_code as string;
  const newCode = data.new_code as string;

  if (!oldCode) return { ...base, status: "error", error: "old_code is required and cannot be empty" };
  if (newCode === undefined) return { ...base, status: "error", error: "new_code is required" };

  // Reject inline base64 data URIs in the NEW code only. Existing files may
  // still contain legacy data URIs elsewhere — those pass through — but every
  // edit must not introduce new bloat.
  const assetErr = assertNoInlineDataUris(newCode, `edit_custom_ui "${id}" new_code`);
  if (assetErr) return { ...base, status: "error", error: assetErr };

  // Every world has rootComponent after migration.
  ensureRootComponent(draft);
  if (!draft.rootComponent) {
    return { ...base, status: "error", error: "Internal: rootComponent missing after ensure()" };
  }
  const rc = draft.rootComponent;

  // Resolve target file: if id is an existing filename use it directly; if it
  // ends with .tsx but doesn't exist yet, create it; non-filename IDs address
  // the entry file (so "root-component" or a UUID resolves sensibly).
  const isFilename = id.includes(".");
  const targetFile = (isFilename && id in rc.files)
    ? id
    : isFilename && id.endsWith(".tsx")
      ? id
      : rc.entryFile;
  const ownedErr = uiDocOwnedFileError(draft, targetFile, "edit");
  if (ownedErr) return { ...base, id: targetFile, status: "error", error: ownedErr };
  const existingCode = rc.files[targetFile];
  if (!existingCode) {
    return { ...base, status: "error", error: `File not found: "${targetFile}" in rootComponent. Available: [${Object.keys(rc.files).join(", ")}]` };
  }

  // Resolve the span to replace. Prefer an exact unique match; if old_code is
  // not found verbatim, fall back to a whitespace-tolerant UNIQUE match (the
  // model often reproduces a region with slightly different indentation). On 0
  // or >1 matches we return a near-miss code window so the model self-corrects
  // WITHOUT re-reading the file (the read-spiral).
  // Resolve the span to replace via a cascade of matchers (exact → line-trimmed →
  // block-anchor → whitespace → indentation → escape → trimmed → context-aware),
  // each accepted only when its candidate is UNIQUE in the file. Rescues the common
  // case where the model reproduces a region with slightly different indentation or
  // escaping, without ever silently editing an ambiguous region.
  const exactCount = countOccurrences(existingCode, oldCode);
  if (exactCount > 1) {
    return { ...base, status: "error", error: `old_code appears ${exactCount} times in ${targetFile} — include more surrounding lines for a unique match.` };
  }
  const match = resolveUniqueMatch(existingCode, oldCode);
  if (!match.ok) {
    if (match.reason === "ambiguous") {
      return { ...base, status: "error", error: `old_code is not unique in ${targetFile} — it matches multiple regions. Include more surrounding lines so the match is unambiguous.` };
    }
    const hint = nearestRegion(existingCode, oldCode);
    return {
      ...base,
      status: "error",
      error: `old_code not found in ${targetFile} (tried exact, whitespace-, indentation-, escape- and anchor-based matching). The code has likely changed.`
        + (hint ? `\nClosest region currently in ${targetFile}:\n${hint}\n` : "")
        + ` Copy old_code verbatim from the snippet above (or call validate_world / read_entities with offset_lines to see the exact current text).`,
    };
  }
  const spanStart = match.span.start;
  const spanEnd = match.span.end;

  const result = existingCode.slice(0, spanStart) + newCode + existingCode.slice(spanEnd);

  const compileErr = compileTsx(result);
  if (compileErr) return { ...base, status: "error", error: `Edit produced invalid TSX:\n${compileErr}` };

  rc.files[targetFile] = result;
  rc.updatedAt = new Date().toISOString();
  return { ...base, id: targetFile, status: "success", note: `Edited ${targetFile}: replaced ${oldCode.length} chars → ${newCode.length} chars` + rootUiConnectionNote(rc, targetFile) };
}

/** Count non-overlapping occurrences of a substring */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// ── Audio CRUD ──

function applyAudioChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "audio", id };
  if (!draft.audioTracks) draft.audioTracks = [];

  // Reject inline audio data URIs — same CDN/cache argument as TSX. Enforced on
  // create + update; legacy tracks in the DB keep playing but new writes must use @asset:.
  if ((action === "create" || action === "update") && typeof data.url === "string" && data.url.startsWith("data:")) {
    return { ...base, status: "error", error: `write_audio "${id}" rejected: url starts with "data:" (inline base64). Upload the audio file via the asset picker and set url to "@asset:{assetId}" so it streams from CDN.` };
  }

  if (action === "create") {
    const existing = draft.audioTracks.find((t) => t.id === id);
    if (existing) {
      applyAudioUpdates(existing, data);
      return { ...base, status: "success" };
    }

    const newTrack: AudioTrack = {
      id,
      name: (data.name as string) ?? "New Track",
      type: (data.type as AudioTrack["type"]) ?? "bgm",
      url: (data.url as string) ?? "",
      loop: data.loop as boolean | undefined,
      volume: data.volume as number | undefined,
      fadeIn: data.fadeIn as number | undefined,
      fadeOut: data.fadeOut as number | undefined,
      maxDuration: data.maxDuration as number | undefined,
    };
    applyAudioUpdates(newTrack, { aiNote: data.aiNote, allowAiControl: data.allowAiControl });
    draft.audioTracks.push(newTrack);
    return { ...base, status: "success" };
  }

  if (action === "update") {
    const track = draft.audioTracks.find((t) => t.id === id);
    if (!track) return { ...base, status: "error", error: `Audio track not found: ${id}` };
    applyAudioUpdates(track, data);
    return { ...base, status: "success" };
  }

  if (action === "delete") {
    const idx = draft.audioTracks.findIndex((t) => t.id === id);
    if (idx === -1) return { ...base, status: "error", error: `Audio track not found: ${id}` };
    draft.audioTracks.splice(idx, 1);
    return { ...base, status: "success" };
  }

  return { ...base, status: "error", error: `Unknown action: ${action}` };
}

function applyAudioUpdates(track: AudioTrack, data: Record<string, unknown>): void {
  if (data.name !== undefined) track.name = data.name as string;
  if (data.type !== undefined) track.type = data.type as AudioTrack["type"];
  if (data.url !== undefined) track.url = data.url as string;
  if (data.loop !== undefined) track.loop = data.loop as boolean;
  if (data.volume !== undefined) track.volume = data.volume as number;
  if (data.fadeIn !== undefined) track.fadeIn = data.fadeIn as number;
  if (data.fadeOut !== undefined) track.fadeOut = data.fadeOut as number;
  if (data.maxDuration !== undefined) track.maxDuration = data.maxDuration as number;
  if (typeof data.aiNote === "string") track.aiNote = data.aiNote.trim() || undefined;
  if (typeof data.allowAiControl === "boolean") track.allowAiControl = data.allowAiControl ? undefined : false;
}

/** A non-empty voice argument that is not a fish.audio id → the error the
 *  model sees, so it corrects the id instead of the write silently dropping it. */
function invalidVoiceError(tool: string, id: string, field: string, raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || voiceArg(raw)) return null;
  return `${tool} "${id}" rejected: ${field} "${raw}" is not a fish.audio voice id (32 lowercase hex). Use one from the curated list in the tool description, an id the creator gave you, or "" to clear it.`;
}

/** A voice argument → a stored fish.audio id, or undefined to clear it. An
 *  empty string clears; anything that is not 32 hex is dropped rather than
 *  saved, since a bad id is a hard provider error the moment readout plays. */
function voiceArg(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim().toLowerCase();
  return isValidTtsVoice(id) ? id : undefined;
}

// ── Scene images ──

function applySceneImageChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "sceneImage", id };
  if (!draft.sceneImages) draft.sceneImages = [];

  if ((action === "create" || action === "update") && typeof data.url === "string" && data.url.startsWith("data:")) {
    return { ...base, status: "error", error: `write_scene_image "${id}" rejected: url starts with "data:" (inline base64). Upload the picture via the asset picker and set url to "@asset:{assetId}" so it streams from CDN.` };
  }

  const apply = (img: SceneImage) => {
    if (data.name !== undefined) img.name = String(data.name);
    if (data.url !== undefined) img.url = String(data.url);
    if (data.scene !== undefined) img.scene = String(data.scene);
    if (data.hint !== undefined) img.hint = data.hint ? String(data.hint) : undefined;
    if (data.greetingIds !== undefined) {
      const ids = Array.isArray(data.greetingIds) ? (data.greetingIds as unknown[]).filter((g): g is string => typeof g === "string") : [];
      img.greetingIds = ids.length ? ids : undefined;
    }
    if (data.allowAiControl !== undefined) img.allowAiControl = data.allowAiControl === false ? false : undefined;
  };

  if (action === "create") {
    const existing = draft.sceneImages.find((img) => img.id === id);
    if (existing) { apply(existing); return { ...base, status: "success" }; }
    const created: SceneImage = { id, name: (data.name as string) ?? "", url: (data.url as string) ?? "", scene: (data.scene as string) ?? "" };
    apply(created);
    draft.sceneImages.push(created);
    return { ...base, status: "success" };
  }
  if (action === "update") {
    const img = draft.sceneImages.find((x) => x.id === id);
    if (!img) return { ...base, status: "error", error: `Scene image not found: ${id}` };
    apply(img);
    return { ...base, status: "success" };
  }
  if (action === "delete") {
    const idx = draft.sceneImages.findIndex((x) => x.id === id);
    if (idx === -1) return { ...base, status: "error", error: `Scene image not found: ${id}` };
    draft.sceneImages.splice(idx, 1);
    return { ...base, status: "success" };
  }
  return { ...base, status: "error", error: `Unknown action: ${action}` };
}

// ── Settings ──

/**
 * Set style knobs on a decomposed base frontend (the 拆积木 result) and
 * recompile the interface so play sees the change without waiting for a
 * client-side save. Values are validated against the knob's declared kind —
 * a number knob rejects "red", which otherwise compiles to `"red" + "em"`.
 */
function applyUiKnobsChange(draft: WorldDefinition, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action: "update", entityType: "uiKnobs", id: "ui-knobs" };
  const groups = draft.uiDoc?.base?.groups;
  if (!groups?.length) {
    return { ...base, status: "error", error: "This card has no decomposed base knobs (uiDoc.base.groups is empty)." };
  }
  const edits = Array.isArray(data.knobs) ? (data.knobs as Array<{ id?: unknown; value?: unknown }>) : [];
  if (edits.length === 0) {
    return { ...base, status: "error", error: "set_ui_knobs requires a non-empty 'knobs' array of { id, value }." };
  }

  const byId = new Map<string, { kind: string; set: (v: string | number) => void }>();
  for (const g of groups) {
    for (const k of g.knobs) {
      byId.set(k.id, { kind: k.kind, set: (v) => { k.value = v; } });
    }
  }

  for (const edit of edits) {
    const id = typeof edit.id === "string" ? edit.id : "";
    const target = byId.get(id);
    if (!target) {
      const known = [...byId.keys()].slice(0, 40).join(", ");
      return { ...base, status: "error", error: `Unknown knob id "${id}". Known knobs: ${known}` };
    }
    if (target.kind === "number") {
      const num = typeof edit.value === "number" ? edit.value : Number(edit.value);
      if (!Number.isFinite(num)) {
        return { ...base, status: "error", error: `Knob "${id}" is a number knob; got ${JSON.stringify(edit.value)}.` };
      }
      target.set(num);
    } else {
      if (typeof edit.value !== "string" && typeof edit.value !== "number") {
        return { ...base, status: "error", error: `Knob "${id}" needs a string value.` };
      }
      target.set(String(edit.value));
    }
  }

  // Recompile so the change reaches play immediately. Mirrors the client's
  // save-time compile: generated files overwrite, siblings survive, and the
  // stale precompiled bundle is dropped (play falls back to the live compile).
  try {
    draft.rootComponent = compileUiDocInto(draft.uiDoc!, draft.rootComponent);
  } catch (e) {
    return { ...base, status: "error", error: `Knobs updated but the interface failed to recompile: ${e instanceof Error ? e.message : "unknown"}` };
  }

  return { ...base, status: "success" };
}

/**
 * Install the 拆积木 decomposition itself: the knob GROUPS of a preserved base
 * frontend, written by the studio AI after it rewrote the base code to read
 * from `_knobs`. The executor is the gate — the rewrite (edit_custom_ui calls
 * earlier in the same reply) and the groups land in one atomic batch, and any
 * mismatch between what the code reads and what the groups declare rejects
 * the whole batch, so a card can never persist half-decomposed.
 */
function applyUiKnobGroupsChange(draft: WorldDefinition, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action: "update", entityType: "uiKnobGroups", id: "ui-knob-groups" };

  const rc = draft.rootComponent;
  if (!rc?.files || Object.keys(rc.files).length === 0) {
    return { ...base, status: "error", error: "This card has no frontend code to decompose (rootComponent is empty)." };
  }

  const parsed = uiKnobGroupsSchema.safeParse(data.groups);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `groups.${i.path.join(".")}: ${i.message}`).join("; ");
    return { ...base, status: "error", error: `Invalid groups: ${issues}` };
  }
  const groups = parsed.data;

  // kind/value coherence + id uniqueness — the schema's union can't see
  // across fields, and a "2.85" that should be 2.85 would compile to
  // `"2.85" + "em"` silently.
  const knobIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const g of groups) {
    if (groupIds.has(g.id)) return { ...base, status: "error", error: `Duplicate group id "${g.id}".` };
    groupIds.add(g.id);
    for (const k of g.knobs) {
      if (knobIds.has(k.id)) return { ...base, status: "error", error: `Duplicate knob id "${k.id}".` };
      knobIds.add(k.id);
      if (k.kind === "number" && typeof k.value !== "number") {
        return { ...base, status: "error", error: `Knob "${k.id}" is a number knob; its value must be a bare number, got ${JSON.stringify(k.value)}.` };
      }
      if (k.kind !== "number" && typeof k.value !== "string") {
        return { ...base, status: "error", error: `Knob "${k.id}" is a ${k.kind} knob; its value must be a string.` };
      }
    }
  }

  // A card that never met the builder gets wrapped here, exactly the way the
  // builder's own adoption does it: the current frontend becomes the
  // document's preserved base — content untouched, entry regenerated below.
  if (!draft.uiDoc) {
    if (rc.generatedFrom === "uiDoc") {
      return { ...base, status: "error", error: "Inconsistent card: a generated interface without its document. Open the interface builder once, or report this." };
    }
    const files = { ...rc.files };
    let baseFile = rc.entryFile || "index.tsx";
    if (baseFile === "index.tsx") {
      baseFile = "_base.tsx";
      for (let i = 2; baseFile in files; i++) baseFile = `_base-${i}.tsx`;
      files[baseFile] = files["index.tsx"]!;
    }
    delete files["index.tsx"];
    draft.uiDoc = {
      version: 1,
      entryPageId: "page-1",
      pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }],
      base: { file: baseFile },
    };
    draft.rootComponent = { ...rc, files };
  }
  if (!draft.uiDoc.base) {
    return { ...base, status: "error", error: "This card's interface is built from the visual document alone — there is no preserved base frontend to decompose." };
  }

  // The contract between code and groups, checked against the batch's OWN
  // rewrites (changes apply in order, so the edit_custom_ui calls earlier in
  // this reply are already in these files).
  const files = draft.rootComponent!.files;
  const contentFiles = Object.entries(files).filter(([p]) => p !== "index.tsx" && p !== "_knobs.tsx");
  const allCode = contentFiles.map(([, c]) => c).join("\n");
  for (const id of knobIds) {
    if (!allCode.includes(`K["${id}"]`)) {
      return { ...base, status: "error", error: `Knob "${id}" is never read: no K["${id}"] in the code. Rewrite the code first (edit_custom_ui, earlier in the SAME reply), then install the groups.` };
    }
  }
  for (const gid of groupIds) {
    if (!allCode.includes(`data-knob-group="${gid}"`)) {
      return { ...base, status: "error", error: `Group "${gid}" has no data-knob-group="${gid}" tag in the code — the canvas cannot hit-test it. Tag the region's outermost JSX element.` };
    }
  }
  const refRe = /\bK\[\s*"([^"]+)"\s*\]/g;
  for (const [path, code] of contentFiles) {
    const readsKnobs = /\bK\[\s*"/.test(code);
    const knobImport = code.match(/\bimport\s+K\s+from\s*(["'])([^"']+)\1/)?.[2];
    const importedPath = knobImport?.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), knobImport)) : null;
    if (readsKnobs && importedPath !== "_knobs" && importedPath !== "_knobs.tsx") {
      const relativePath = posix.relative(posix.dirname(path), "_knobs");
      const expected = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
      return { ...base, status: "error", error: `${path} reads K["…"] but never imports the knobs module at the card root — add \`import K from "${expected}";\` at its top.` };
    }
    if (!readsKnobs) continue;
    for (const m of code.matchAll(refRe)) {
      if (!knobIds.has(m[1]!)) {
        return { ...base, status: "error", error: `${path} reads K["${m[1]}"] but no such knob is declared — declare it or remove the reference.` };
      }
    }
  }

  draft.uiDoc.base.groups = groups;

  // Recompile so the decomposition (and _knobs.tsx) reaches play immediately.
  try {
    draft.rootComponent = compileUiDocInto(draft.uiDoc, draft.rootComponent);
  } catch (e) {
    return { ...base, status: "error", error: `Groups installed but the interface failed to recompile: ${e instanceof Error ? e.message : "unknown"}` };
  }

  const totalKnobs = groups.reduce((n, g) => n + g.knobs.length, 0);
  return { ...base, status: "success", note: `${groups.length} groups, ${totalKnobs} knobs` };
}

/**
 * edit_ui_doc: structural edits to the interface document, validated against
 * the engine's schema and recompiled into rootComponent in the same step, so
 * play reflects them without waiting for an editor save.
 */
function applyUiDocChange(draft: WorldDefinition, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action: "update", entityType: "uiDoc", id: "ui-doc" };
  const outcome = applyUiDocOps(draft, data.ops);
  if (!outcome.ok) return { ...base, status: "error", error: outcome.error };
  return { ...base, status: "success", ...(outcome.note ? { note: outcome.note } : {}) };
}

/** Numeric settings update_settings may write, with the ranges of
 *  worldSettingsSchema (packages/engine/src/world/schema.ts). Keep in sync:
 *  a value outside them fails the schema on the next load of the card. */
const NUMERIC_SETTINGS: Record<string, { min: number; max: number; int?: boolean }> = {
  maxTokens: { min: 1, max: Number.MAX_SAFE_INTEGER, int: true },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  frequencyPenalty: { min: -2, max: 2 },
  presencePenalty: { min: -2, max: 2 },
  topK: { min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
  minP: { min: 0, max: 1 },
  lorebookScanDepth: { min: 1, max: Number.MAX_SAFE_INTEGER, int: true },
  lorebookRecursionDepth: { min: 0, max: 10, int: true },
  lorebookBudgetCap: { min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
  lorebookBudgetPercent: { min: 0, max: 100 },
};

/** A finite number, or a string that is exactly one ("0.8"); anything else is null. */
function coerceSettingNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?(\d+\.?\d*|\.\d+)(e-?\d+)?\s*$/i.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function applySettingsChange(draft: WorldDefinition, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action: "update", entityType: "settings", id: "settings" };

  // Validate everything before writing anything: one bad value rejects the
  // call, so the model sees the error and no half-applied settings persist.
  const updates: Record<string, unknown> = {};
  const invalid: string[] = [];
  const adjusted: string[] = [];
  for (const [key, range] of Object.entries(NUMERIC_SETTINGS)) {
    if (data[key] === undefined) continue;
    const n = coerceSettingNumber(data[key]);
    if (n === null) { invalid.push(`${key} must be a number (got ${JSON.stringify(data[key])})`); continue; }
    let value = range.int ? Math.round(n) : n;
    value = Math.min(range.max, Math.max(range.min, value));
    if (value !== n) adjusted.push(`${key} ${n} → ${value}`);
    updates[key] = value;
  }
  if (data.playerName !== undefined) {
    if (typeof data.playerName !== "string" || !data.playerName.trim()) invalid.push(`playerName must be a non-empty string`);
    else updates.playerName = data.playerName;
  }
  // The card's own name and blurb live on the definition, not in settings.
  // Without them a card the assistant wrote end to end still carried its
  // template's name and blurb, and publishing stopped on both.
  const card: { name?: string; description?: string } = {};
  if (data.name !== undefined) {
    if (typeof data.name !== "string" || !data.name.trim()) invalid.push(`name must be a non-empty string`);
    else if (data.name.trim().length > 80) invalid.push(`name must be at most 80 characters`);
    else card.name = data.name.trim();
  }
  if (data.description !== undefined) {
    if (typeof data.description !== "string") invalid.push(`description must be a string`);
    else if (data.description.trim().length > 500) invalid.push(`description must be at most 500 characters`);
    else card.description = data.description.trim();
  }
  // 回复处理 rules and the per-speaker bubbles switch: checked by the
  // engine's own schema; one bad rule rejects the call.
  let replyRules: WorldDefinition["replyRules"] | null = null;
  if (data.replyRules !== undefined) {
    const parsed = worldDefinitionSchema.shape.replyRules.safeParse(data.replyRules);
    if (!parsed.success) invalid.push(`replyRules: ${parsed.error.issues[0]?.message ?? "invalid"} at ${parsed.error.issues[0]?.path.join(".") ?? ""}`);
    else replyRules = parsed.data ?? [];
  }
  if (data.speakerBubbles !== undefined) {
    if (typeof data.speakerBubbles !== "boolean") invalid.push(`speakerBubbles must be true or false`);
    else updates.speakerBubbles = data.speakerBubbles || undefined;
  }
  // Voices and voice input (main): a bad fish.audio id is an error the model
  // sees, never a silently dropped write.
  const badVoice = invalidVoiceError("update_settings", "settings", "narratorVoice", data.narratorVoice);
  if (badVoice) invalid.push(badVoice);
  else if (typeof data.narratorVoice === "string") updates.narratorVoice = voiceArg(data.narratorVoice);
  if (data.voiceInputMode !== undefined) {
    if (data.voiceInputMode === "confirm" || data.voiceInputMode === "auto") updates.voiceInputMode = data.voiceInputMode;
    else invalid.push(`voiceInputMode must be "confirm" or "auto"`);
  }
  if (invalid.length > 0) {
    return { ...base, status: "error", error: `update_settings rejected, nothing was changed: ${invalid.join("; ")}.` };
  }
  if (replyRules !== null) draft.replyRules = replyRules.length ? replyRules : undefined;
  if (card.name !== undefined) draft.name = card.name;
  if (card.description !== undefined) draft.description = card.description;

  if (!draft.settings) draft.settings = {} as WorldDefinition["settings"];
  Object.assign(draft.settings as Record<string, unknown>, updates);
  // Smart tracking switches (the editor's 「智能追踪」).
  if (data.continuity && typeof data.continuity === "object" && !Array.isArray(data.continuity)) {
    const c = data.continuity as Record<string, unknown>;
    const next = { ...(draft.continuity ?? {}) };
    for (const key of ["enabled", "bgm", "sfx", "images"] as const) {
      if (typeof c[key] === "boolean") next[key] = c[key] as boolean;
    }
    if (c.music && typeof c.music === "object" && !Array.isArray(c.music)) {
      const m = c.music as Record<string, unknown>;
      const music = { ...(next.music ?? {}) };
      for (const key of ["overRules", "once", "duck"] as const) {
        if (typeof m[key] === "boolean") music[key] = m[key] as boolean;
      }
      next.music = music;
    }
    draft.continuity = next;
  }

  return {
    ...base, status: "success",
    ...(adjusted.length > 0 ? { note: `adjusted to the allowed range: ${adjusted.join(", ")}` } : {}),
  };
}

// ── Worldbook CRUD ──

/** Normalize the AI-provided 模块总控. Structural cleanup only — an unknown
 *  source id is left in place, because in a batched create the source module
 *  may be written later in the same reply and the runtime skips dead wires
 *  safely either way. Self-reference IS dropped: that one is never a
 *  batching artefact, it is a mistake. */
function normalizeStation(raw: unknown, selfId: string): Worldbook["station"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  // A custom station is a declared slot: nothing to normalize but its name.
  if (r.kind === "custom") return { kind: "custom", ...(typeof r.name === "string" && r.name.trim() ? { name: r.name.trim().slice(0, 80) } : {}) };
  const kind = r.kind === "worker" ? "worker" : r.kind === "narrator" ? "narrator" : null;
  if (!kind) return undefined;

  const inputs = Array.isArray(r.inputs)
    ? r.inputs
        .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
        .map((i) => {
          const from = typeof i.from === "string" ? i.from.trim() : "";
          const as = i.as === "lore" ? ("lore" as const) : i.as === "history" ? ("history" as const) : undefined;
          const rawLimit = typeof i.limit === "number" && Number.isFinite(i.limit) ? Math.floor(i.limit) : undefined;
          if (i.kind === "transcript") {
            return { kind: "transcript" as const, from, limit: Math.max(1, Math.min(40, rawLimit ?? 10)), ...(as ? { as } : {}) };
          }
          if (i.kind === "variables") return { kind: "variables" as const, from, ...(as ? { as } : {}) };
          const k = i.kind === "worker" ? ("worker" as const) : ("memory" as const);
          return {
            kind: k,
            from,
            ...(as ? { as } : {}),
            ...(rawLimit !== undefined ? { limit: Math.max(1, Math.min(20, rawLimit)) } : {}),
          };
        })
        .filter((i) => i.from && (i.from !== selfId || i.kind === "variables") && i.from !== selfId)
        .slice(0, 12)
    : undefined;

  let trigger: NonNullable<Worldbook["station"]>["trigger"];
  const t = r.trigger;
  if (kind === "worker" && t && typeof t === "object" && !Array.isArray(t)) {
    const tr = t as Record<string, unknown>;
    if (tr.on === "module-closed" && typeof tr.from === "string" && tr.from.trim()) {
      trigger = { on: "module-closed", from: tr.from.trim() };
    } else if (tr.on === "turns" && typeof tr.every === "number" && Number.isFinite(tr.every)) {
      trigger = { on: "turns", every: Math.max(1, Math.min(100, Math.floor(tr.every))) };
    } else if (tr.on === "conditions") {
      trigger = { on: "conditions", conditions: mapConditions(tr.conditions), conditionLogic: tr.conditionLogic === "any" ? "any" : "all" };
    } else if (tr.on === "after" && typeof tr.from === "string" && tr.from.trim()) {
      trigger = { on: "after", from: tr.from.trim() };
    } else if (tr.on === "quiet" && typeof tr.seconds === "number" && Number.isFinite(tr.seconds)) {
      trigger = { on: "quiet", seconds: Math.max(15, Math.min(3600, Math.floor(tr.seconds))) };
    } else if (tr.on === "ui") {
      trigger = { on: "ui" };
    }
  }

  return {
    kind,
    ...(typeof r.model === "string" && r.model.trim() ? { model: r.model.trim().slice(0, 200) } : {}),
    ...(inputs && inputs.length > 0 ? { inputs } : {}),
    ...(kind === "narrator" && (r.onClose === "keep" || r.onClose === "archive") ? { onClose: r.onClose } : {}),
    // A pool name, or the legacy own-memory flag (a pool of one). Either way
    // the reader is resolveStation, which knows both spellings.
    ...(kind === "narrator" && typeof r.memoryPool === "string" && r.memoryPool.trim()
      ? { memoryPool: r.memoryPool.trim().slice(0, 64) }
      : kind === "narrator" && r.history === "own"
        ? { history: "own" as const }
        : {}),
    ...(typeof r.archivePrompt === "string" && r.archivePrompt ? { archivePrompt: r.archivePrompt.slice(0, 2000) } : {}),
    ...(trigger ? { trigger } : {}),
    ...(kind === "worker" && typeof r.task === "string" && r.task.trim() ? { task: r.task.slice(0, 4000) } : {}),
    ...(typeof r.name === "string" && r.name.trim() ? { name: r.name.trim().slice(0, 60) } : {}),
    // 自定义: kept only when each part is the shape the engine reads.
    ...customStationParts(r),
  };
}

/** The custom (自定义) parts of a station, each validated by the engine's
 *  own schema and dropped when it is not that shape. */
function customStationParts(r: Record<string, unknown>): Partial<NonNullable<Worldbook["station"]>> {
  const shape = moduleStationSchema.shape;
  const out: Record<string, unknown> = {};
  for (const key of ["sees", "pieces", "output", "say", "onError", "cooldownSec", "maxTokens"] as const) {
    if (r[key] === undefined) continue;
    const parsed = shape[key].safeParse(r[key]);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out as Partial<NonNullable<Worldbook["station"]>>;
}

/** Normalize a worldbookId arg: "", "core", null → undefined (the always-on Core book). */
function normalizeWorldbookId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "core") return undefined;
  return trimmed;
}

/** Coerce a JSON object into the {varId: number|string|boolean} shape initialVariables expects. */
function toInitialVariables(raw: unknown): Record<string, number | string | boolean> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Normalize the AI-provided activation object into a valid WorldbookActivation
 *  (discriminated union; drops stray fields, fills schema defaults). */
function normalizeWorldbookActivation(raw: unknown): Worldbook["activation"] {
  const a = (raw && typeof raw === "object" && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
  const mode = a.mode;
  if (mode === "conditions") {
    return { mode: "conditions", conditions: mapConditions(a.conditions), conditionLogic: a.conditionLogic === "any" ? "any" : "all" };
  }
  if (mode === "greeting") {
    const greetingIds = Array.isArray(a.greetingIds)
      ? (a.greetingIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    return { mode: "greeting", greetingIds };
  }
  if (mode === "manual") return { mode: "manual" };
  if (mode === "keywords") {
    // Dropping this mode made a "say 阁楼 to enter" situation always on: the
    // assistant reported the door and the card had none.
    const keywords = Array.isArray(a.keywords)
      ? (a.keywords as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
      : [];
    const leaveKeywords = Array.isArray(a.leaveKeywords)
      ? (a.leaveKeywords as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
      : [];
    return { mode: "keywords", keywords, ...(a.exclusive === true ? { exclusive: true } : {}), ...(leaveKeywords.length ? { leaveKeywords } : {}) };
  }
  return { mode: "always" };
}

function applyWorldbookChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "worldbook", id };
  if (!draft.worldbooks) draft.worldbooks = [];

  if (action === "create") {
    const existing = draft.worldbooks.find((w) => w.id === id);
    if (existing) {
      applyWorldbookUpdates(existing, data);
      return { ...base, status: "success" };
    }
    const maxOrder = draft.worldbooks.reduce((m, w) => Math.max(m, w.order ?? -1), -1);
    const newBook: Worldbook = {
      id,
      name: (data.name as string) ?? id,
      description: data.description as string | undefined,
      note: typeof data.note === "string" ? data.note.slice(0, 4000) : undefined,
      frontendFile: typeof data.frontendFile === "string" && data.frontendFile ? data.frontendFile.slice(0, 200) : undefined,
      enabled: data.enabled === undefined ? true : (data.enabled as boolean),
      activation: data.activation !== undefined ? normalizeWorldbookActivation(data.activation) : { mode: "always" },
      station: normalizeStation(data.station, id),
      ...(typeof data.host === "string" && data.host.trim() ? { host: data.host.trim().slice(0, 128) } : {}),
      ...(data.narratorHere === true ? { narratorHere: true } : {}),
      order: (data.order as number) ?? maxOrder + 1,
      color: data.color as string | undefined,
    };
    draft.worldbooks.push(newBook);
    return { ...base, status: "success" };
  }

  if (action === "update") {
    const book = draft.worldbooks.find((w) => w.id === id);
    if (!book) return { ...base, status: "error", error: `Worldbook not found: "${id}".${suggestSimilarIds(id, draft.worldbooks.map((w) => w.id))}` };
    applyWorldbookUpdates(book, data);
    return { ...base, status: "success" };
  }

  if (action === "delete") {
    const idx = draft.worldbooks.findIndex((w) => w.id === id);
    if (idx === -1) return { ...base, status: "error", error: `Worldbook not found: ${id}` };
    draft.worldbooks.splice(idx, 1);
    // Orphan its members back to Core so they don't silently vanish/deactivate.
    for (const e of draft.entries) {
      if (e.worldbookId === id) e.worldbookId = undefined;
    }
    for (const v of draft.variables) {
      if (v.worldbookId === id) v.worldbookId = undefined;
    }
    for (const r of draft.reactions ?? []) {
      if (r.worldbookId === id) r.worldbookId = undefined;
    }
    for (const folder of draft.entryFolders ?? []) {
      if (folder.worldbookId === id) folder.worldbookId = undefined;
    }
    return { ...base, status: "success" };
  }

  return { ...base, status: "error", error: `Unknown action: ${action}` };
}

function applyWorldbookUpdates(book: Worldbook, data: Record<string, unknown>): void {
  if (data.name !== undefined) book.name = data.name as string;
  if (data.description !== undefined) book.description = data.description as string;
  // The blackboard note. "" erases it — a sticky you can peel off matters as
  // much as one you can write.
  if (data.note !== undefined) book.note = typeof data.note === "string" && data.note ? data.note.slice(0, 4000) : undefined;
  // Which scene file of the frontend is this module's face. "" unsets it.
  if (data.frontendFile !== undefined) {
    book.frontendFile = typeof data.frontendFile === "string" && data.frontendFile ? data.frontendFile.slice(0, 200) : undefined;
  }
  // null is how a station is taken back off — the module survives, the
  // machinery goes.
  if (data.station !== undefined) book.station = normalizeStation(data.station, book.id);
  // Where an AI lives; "" or null puts it back to the older shape.
  if (data.host !== undefined) {
    if (typeof data.host === "string" && data.host.trim()) book.host = data.host.trim().slice(0, 128);
    else delete book.host;
  }
  if (data.narratorHere !== undefined) {
    if (data.narratorHere === true) book.narratorHere = true;
    else delete book.narratorHere;
  }
  if (data.enabled !== undefined) book.enabled = data.enabled as boolean;
  if (data.activation !== undefined) book.activation = normalizeWorldbookActivation(data.activation);
  if (data.order !== undefined) book.order = data.order as number;
  if (data.color !== undefined) book.color = data.color as string;
}

// ── Lore UI Binding CRUD ──
// id == slotId (the binding key — frontend <LoreSlot id> / <LoreButton slotId>).

function applyLoreBindingChange(draft: WorldDefinition, action: string, id: string, data: Record<string, unknown>, index: number): ChangeResult {
  const base = { index, action, entityType: "loreBinding", id };
  if (!draft.loreUiBindings) draft.loreUiBindings = [];

  if (action === "delete") {
    const idx = draft.loreUiBindings.findIndex((b) => b.slotId === id);
    if (idx === -1) return { ...base, status: "error", error: `Lore binding not found for slot: ${id}` };
    draft.loreUiBindings.splice(idx, 1);
    return { ...base, status: "success" };
  }

  // create or update — upsert by slotId
  const entryId = data.entryId as string | undefined;
  const existing = draft.loreUiBindings.find((b) => b.slotId === id);
  if (existing) {
    if (entryId !== undefined) {
      if (!draft.entries.find((e) => e.id === entryId)) {
        return { ...base, status: "error", error: `Lore binding entryId not found: "${entryId}".${suggestSimilarIds(entryId, draft.entries.map((e) => e.id))}` };
      }
      existing.entryId = entryId;
    }
    if (data.conditions !== undefined) existing.conditions = mapConditions(data.conditions);
    if (data.conditionLogic !== undefined) existing.conditionLogic = data.conditionLogic === "any" ? "any" : "all";
    return { ...base, status: "success" };
  }

  if (!entryId) return { ...base, status: "error", error: "write_lore_binding requires 'entryId' when creating a binding" };
  if (!draft.entries.find((e) => e.id === entryId)) {
    return { ...base, status: "error", error: `Lore binding entryId not found: "${entryId}".${suggestSimilarIds(entryId, draft.entries.map((e) => e.id))}` };
  }
  const binding: LoreUiBinding = {
    slotId: id,
    entryId,
    conditions: mapConditions(data.conditions),
    conditionLogic: data.conditionLogic === "any" ? "any" : "all",
  };
  draft.loreUiBindings.push(binding);
  return { ...base, status: "success" };
}

// ── Shared Mapping Helpers ──

function mapConditions(raw: unknown): Condition[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: Record<string, unknown>) => ({
    variableId: (c.variableId ?? c.variable_id ?? "") as string,
    operator: c.operator as Condition["operator"],
    value: c.value as Condition["value"],
  }));
}

function mapEventPattern(when: Record<string, unknown>): EventPattern {
  const pattern: EventPattern = {
    eventType: (when.eventType ?? when.event_type ?? "state:changed") as string,
  };
  if (when.match && typeof when.match === "object") {
    const mappedMatch: Record<string, EventMatchCondition> = {};
    for (const [field, cond] of Object.entries(when.match as Record<string, Record<string, unknown>>)) {
      if (cond && typeof cond === "object" && "operator" in cond && "value" in cond) {
        mappedMatch[field] = {
          operator: cond.operator as EventMatchCondition["operator"],
          value: cond.value as EventMatchCondition["value"],
        };
      }
    }
    if (Object.keys(mappedMatch).length > 0) pattern.match = mappedMatch;
  }
  return pattern;
}

function mapReactionEffects(effects: Array<Record<string, unknown>>): ReactionEffect[] {
  return effects.map((e) => {
    if (e.type === "emit" && e.event) {
      return { type: "emit", event: e.event } as ReactionEffect;
    }
    const setEffect: Record<string, unknown> = {
      type: "set",
      path: (e.path ?? "") as string,
      value: e.value,
    };
    if (e.operation || e.op) setEffect.operation = e.operation ?? e.op;
    // Preserve the two non-literal value sources: another variable's value
    // (valueRef) and a random draw (valueRandom: range/dice/list).
    if (e.valueRef !== undefined) setEffect.valueRef = e.valueRef;
    if (e.valueRandom !== undefined) setEffect.valueRandom = e.valueRandom;
    return setEffect as unknown as ReactionEffect;
  });
}

function mapTrigger(t: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = { type: t.type };
  if (t.variableId !== undefined || t.variable_id !== undefined) mapped.variableId = t.variableId ?? t.variable_id;
  if (t.direction !== undefined) mapped.direction = t.direction;
  if (t.threshold !== undefined) mapped.threshold = t.threshold;
  if (t.atTurn !== undefined || t.at_turn !== undefined) mapped.atTurn = t.atTurn ?? t.at_turn;
  if (t.everyNTurns !== undefined || t.every_n_turns !== undefined) mapped.everyNTurns = t.everyNTurns ?? t.every_n_turns;
  if (t.keywords !== undefined) mapped.keywords = t.keywords;
  if (t.matchWholeWords !== undefined || t.match_whole_words !== undefined) mapped.matchWholeWords = t.matchWholeWords ?? t.match_whole_words;
  if (t.actionId !== undefined || t.action_id !== undefined) mapped.actionId = t.actionId ?? t.action_id;
  return mapped;
}

function mapRuleAction(a: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = { type: a.type };
  if (a.variableId !== undefined || a.variable_id !== undefined) mapped.variableId = a.variableId ?? a.variable_id;
  if (a.operation !== undefined) mapped.operation = a.operation;
  if (a.value !== undefined) mapped.value = a.value;
  if (a.directiveId !== undefined || a.directive_id !== undefined) mapped.directiveId = a.directiveId ?? a.directive_id;
  if (a.content !== undefined) mapped.content = a.content;
  if (a.position !== undefined) mapped.position = a.position;
  if (a.persistent !== undefined) mapped.persistent = a.persistent;
  if (a.duration !== undefined) mapped.duration = a.duration;
  if (a.message !== undefined) mapped.message = a.message;
  if (a.role !== undefined) mapped.role = a.role;
  if (a.entryId !== undefined || a.entry_id !== undefined) mapped.entryId = a.entryId ?? a.entry_id;
  if (a.ruleId !== undefined || a.rule_id !== undefined) mapped.ruleId = a.ruleId ?? a.rule_id;
  if (a.enabled !== undefined) mapped.enabled = a.enabled;
  if (a.trackId !== undefined || a.track_id !== undefined) mapped.trackId = a.trackId ?? a.track_id;
  if (a.action !== undefined) mapped.action = a.action;
  return mapped;
}

// ── TSX Compilation ──

function compileTsx(code: string): string | null {
  if (!code.trim()) return "Empty TSX code";
  // Delegate to validateTsx so a failed compile returns a ready-to-read code
  // window with a caret (not just a bare line number). This is what lets the
  // agent fix an unclosed bracket on a 4,500-line file WITHOUT re-reading it
  // (the read-spiral). validateTsx is storage-agnostic (source string only).
  const issues = validateTsx(code);
  if (issues.length === 0) return null;
  return formatTsxIssue(issues[0]!);
}

// ── Tool Call → SchemaChange Conversion ──

/**
 * Resolve which entity type an ID belongs to by searching all arrays.
 * Used by delete_entities which doesn't know entity types.
 */
export function resolveEntityType(
  world: WorldDefinition,
  id: string,
): SchemaChange["entityType"] | null {
  if (world.entries.find((e) => e.id === id)) return "entry";
  if (world.variables.find((v) => v.id === id)) return "variable";
  if ((world.reactions ?? []).find((r) => r.id === id)) return "behavior";
  if (world.rules.find((r) => r.id === id)) return "rule";
  if ((world.customUI ?? []).find((c) => c.id === id)) return "customUI";
  // Root component — resolve as customUI so applyCustomUIChange handles routing
  if (world.rootComponent &&
      (world.rootComponent.id === id || id === "root-component" || id in world.rootComponent.files)) return "customUI";
  if ((world.audioTracks ?? []).find((a) => a.id === id)) return "audio";
  if ((world.sceneImages ?? []).find((img) => img.id === id)) return "sceneImage";
  if ((world.worldbooks ?? []).find((w) => w.id === id)) return "worldbook";
  if ((world.loreUiBindings ?? []).find((b) => b.slotId === id)) return "loreBinding";
  return null;
}

const TOOL_TO_ENTITY_TYPE: Record<string, SchemaChange["entityType"]> = {
  write_entry: "entry",
  write_variable: "variable",
  write_behavior: "behavior",
  write_custom_ui: "customUI",
  edit_custom_ui: "customUI",
  write_audio: "audio",
  write_scene_image: "sceneImage",
  write_worldbook: "worldbook",
  write_lore_binding: "loreBinding",
};

/** Result of parsing a single tool call into a SchemaChange (or an error) */
export interface ParsedToolCall {
  toolCallId: string;
  toolName: string;
  /** Successfully parsed change (undefined if error) */
  change?: SchemaChange;
  /** Per-tool error message (undefined if success) */
  error?: string;
}

/**
 * Convert an array of write tool calls into per-tool results.
 *
 * Each tool call is parsed individually — a bad JSON argument in one tool
 * does NOT block the others (nanocode/CoreCoder pattern: errors become results).
 *
 * write_* tools → action: "create" (executor upserts if ID exists)
 * update_settings → action: "update", entityType: "settings"
 * delete_entities → expanded to one delete per ID with resolved entity types
 */
export function toolCallsToSchemaChanges(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
  world: WorldDefinition,
): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];

  for (const tc of toolCalls) {
    const name = tc.function.name;

    // Parse arguments individually — catch per-tool
    let args: Record<string, unknown>;
    try {
      args = parseToolArgs(tc.function.arguments);
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        results.push({ toolCallId: tc.id, toolName: name, error: `Expected object arguments but received ${Array.isArray(args) ? "array" : typeof args}` });
        continue;
      }
    } catch (e) {
      results.push({ toolCallId: tc.id, toolName: name, error: e instanceof Error ? e.message : "Failed to parse tool arguments" });
      continue;
    }

    if (name === "delete_entities") {
      const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
      if (ids.length === 0) {
        results.push({ toolCallId: tc.id, toolName: name, error: "delete_entities requires a non-empty 'ids' array" });
        continue;
      }
      for (const id of ids) {
        const entityType = resolveEntityType(world, id);
        results.push({
          toolCallId: tc.id,
          toolName: name,
          change: { action: "delete", entityType: entityType ?? "entry", id },
        });
      }
      continue;
    }

    if (name === "update_settings") {
      results.push({ toolCallId: tc.id, toolName: name, change: { action: "update", entityType: "settings", id: "settings", data: args } });
      continue;
    }

    // set_ui_knobs edits knob VALUES, not an entity with an id of its own.
    if (name === "set_ui_knobs") {
      if (!Array.isArray(args.knobs) || args.knobs.length === 0) {
        results.push({ toolCallId: tc.id, toolName: name, error: "set_ui_knobs requires a non-empty 'knobs' array of { id, value }" });
        continue;
      }
      results.push({ toolCallId: tc.id, toolName: name, change: { action: "update", entityType: "uiKnobs", id: "ui-knobs", data: args } });
      continue;
    }

    // write_ui_knob_groups installs the WHOLE decomposition — one per card.
    if (name === "write_ui_knob_groups") {
      if (!Array.isArray(args.groups) || args.groups.length === 0) {
        results.push({ toolCallId: tc.id, toolName: name, error: "write_ui_knob_groups requires a non-empty 'groups' array" });
        continue;
      }
      results.push({ toolCallId: tc.id, toolName: name, change: { action: "update", entityType: "uiKnobGroups", id: "ui-knob-groups", data: args } });
      continue;
    }

    // edit_ui_doc edits the one interface document — ops, not an entity id.
    if (name === "edit_ui_doc") {
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        results.push({ toolCallId: tc.id, toolName: name, error: "edit_ui_doc requires a non-empty 'ops' array" });
        continue;
      }
      results.push({ toolCallId: tc.id, toolName: name, change: { action: "update", entityType: "uiDoc", id: "ui-doc", data: args } });
      continue;
    }

    // write_lore_binding is keyed by slotId (not id) — map it to the change id.
    if (name === "write_lore_binding") {
      const slotId = typeof args.slotId === "string" ? args.slotId.trim() : "";
      if (!slotId) {
        results.push({ toolCallId: tc.id, toolName: name, error: "write_lore_binding requires a non-empty 'slotId' string" });
        continue;
      }
      if (typeof args.entryId !== "string" || !args.entryId) {
        results.push({ toolCallId: tc.id, toolName: name, error: "write_lore_binding requires an 'entryId' string" });
        continue;
      }
      results.push({ toolCallId: tc.id, toolName: name, change: { action: "create", entityType: "loreBinding", id: slotId, data: args } });
      continue;
    }

    const entityType = TOOL_TO_ENTITY_TYPE[name];
    if (!entityType) {
      results.push({ toolCallId: tc.id, toolName: name, error: `Unknown write tool: ${name}` });
      continue;
    }

    const { id, ...data } = args;
    if (!id || typeof id !== "string") {
      results.push({ toolCallId: tc.id, toolName: name, error: `Missing or invalid 'id' field for ${name}` });
      continue;
    }
    results.push({ toolCallId: tc.id, toolName: name, change: { action: "create", entityType, id: id as string, data } });
  }

  return results;
}
