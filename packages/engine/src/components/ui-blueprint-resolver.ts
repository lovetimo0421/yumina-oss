import type { GameState, Variable } from "../types/index.js";
import type {
  UIBlueprint,
  UIBlueprintBinding,
  UIBlueprintCondition,
  UIBlueprintTrigger,
  UIBlueprintTriggerTrace,
  UIBlueprintNodeTrace,
} from "../types/ui-blueprint.js";

// ── Resolved component types (render-ready) ──

export interface ResolvedStatBar {
  id: string;
  type: "stat-bar";
  name: string;
  order: number;
  placement: "header";
  value: number;
  min: number;
  max: number;
  percentage: number;
  color?: string;
  showValue: boolean;
  showLabel: boolean;
}

export interface ResolvedTextDisplay {
  id: string;
  type: "text-display";
  name: string;
  order: number;
  placement: "header";
  text: string;
  rawValue: string | number | boolean;
  fontSize: "sm" | "md" | "lg";
  icon?: string;
  textColor?: string;
}

export interface ResolvedImagePanel {
  id: string;
  type: "image-panel";
  name: string;
  order: number;
  placement: "header";
  imageUrl: string;
  aspectRatio: "square" | "portrait" | "landscape" | "wide";
  size: "sm" | "md" | "lg" | "full";
  imagePlacement: "left" | "center" | "right";
  fallbackUrl?: string;
}

export interface ResolvedInventoryGrid {
  id: string;
  type: "inventory-grid";
  name: string;
  order: number;
  placement: "header";
  items: string[];
  columns: number;
  maxSlots: number;
}

export interface ResolvedWebPanel {
  id: string;
  type: "web-panel";
  name: string;
  order: number;
  placement: "header";
  htmlUrl?: string;
  html?: string;
  cssUrl?: string;
  css?: string;
  jsUrl?: string;
  js?: string;
  height?: number;
  sandbox?: string;
}

export interface ResolvedError {
  id: string;
  type: "error";
  name: string;
  order: number;
  placement: "header";
  message: string;
}

export type ResolvedComponent =
  | ResolvedStatBar
  | ResolvedTextDisplay
  | ResolvedImagePanel
  | ResolvedInventoryGrid
  | ResolvedWebPanel
  | ResolvedError;

export interface ResolvedUIBlueprintResult {
  widgets: ResolvedComponent[];
  triggerTrace: UIBlueprintTriggerTrace[];
  nodeTrace: UIBlueprintNodeTrace[];
  errors: string[];
}

export function resolveUIBlueprint(
  blueprint: UIBlueprint | undefined,
  state: GameState,
  _variables: Variable[]
): ResolvedUIBlueprintResult {
  if (!blueprint) {
    return { widgets: [], triggerTrace: [], nodeTrace: [], errors: [] };
  }

  const errors: string[] = [];
  const componentById = new Map(blueprint.components.map((c) => [c.id, c]));
  const layoutById = new Map(blueprint.layouts.map((l) => [l.id, l]));

  const triggerTrace = resolveTriggers(blueprint, state, componentById, layoutById);
  const triggerStatusById = new Map(triggerTrace.map((t) => [t.id, t]));

  const bindingsByTarget = new Map<string, UIBlueprintBinding[]>();
  for (const binding of blueprint.bindings ?? []) {
    if (!bindingsByTarget.has(binding.targetId)) bindingsByTarget.set(binding.targetId, []);
    bindingsByTarget.get(binding.targetId)!.push(binding);
  }

  const layoutVisible = new Map<string, boolean>();
  for (const layout of blueprint.layouts) {
    const vis = evaluateVisibility(
      layout.visible !== false,
      layout.triggerIds ?? [],
      layout.triggerLogic ?? "all",
      layout.when,
      state,
      triggerStatusById,
      errors,
      `layout:${layout.id}`
    );
    layoutVisible.set(layout.id, vis);
  }

  const widgets: ResolvedComponent[] = [];
  const nodeTrace: UIBlueprintNodeTrace[] = [];

  for (const comp of blueprint.components) {
    const layout = comp.layoutId ? layoutById.get(comp.layoutId) : undefined;
    const placement = comp.placement ?? layout?.placement ?? "header";
    const orderBase = comp.order ?? layout?.order ?? 0;

    const ownVisible = evaluateVisibility(
      comp.visible !== false,
      comp.triggerIds ?? [],
      comp.triggerLogic ?? "all",
      comp.when,
      state,
      triggerStatusById,
      errors,
      `component:${comp.id}`
    );
    const parentVisible = layout ? layoutVisible.get(layout.id) !== false : true;
    const visible = ownVisible && parentVisible;

    nodeTrace.push({
      id: comp.id,
      type: comp.type,
      visible,
      placement,
      order: orderBase,
      triggerIds: comp.triggerIds ?? [],
      triggerLogic: comp.triggerLogic ?? "all",
      when: comp.when,
      reason: !parentVisible ? `layout ${layout?.id} is hidden` : undefined,
    });

    if (!visible) continue;

    const props = { ...(comp.props ?? {}) };
    const displayName = resolveDisplayName(comp.id, comp.name, comp.props ?? {});
    const bindings = bindingsByTarget.get(comp.id) ?? [];
    for (const binding of bindings) {
      const resolved = resolveBindingValue(binding, state, errors);
      props[binding.prop] = resolved;
    }

    const widget = mapComponentToWidget(comp.id, comp.type, displayName, orderBase, placement, props);
    if (widget) {
      widgets.push(widget);
    } else {
      widgets.push(
        makeError(
          comp.id,
          displayName,
          orderBase,
          placement,
          `Unsupported uiBlueprint component type: ${comp.type}`
        )
      );
    }
  }

  widgets.sort((a, b) => a.order - b.order);

  return { widgets, triggerTrace, nodeTrace, errors };
}

function resolveDisplayName(
  id: string,
  explicitName: string | undefined,
  rawProps: Record<string, unknown>
): string {
  if (typeof explicitName === "string" && explicitName.trim().length > 0) {
    return explicitName.trim();
  }

  const rawLabel = rawProps.label;
  if (typeof rawLabel === "string" && rawLabel.trim().length > 0) {
    return rawLabel.trim();
  }

  return humanizeComponentId(id);
}

function humanizeComponentId(id: string): string {
  const withoutPrefix = id.replace(/^(cmp|component|widget)[_-]/i, "");
  const words = withoutPrefix
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();

  if (!words) return id;

  return words
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveTriggers(
  blueprint: UIBlueprint,
  state: GameState,
  componentById: Map<string, { triggerIds?: string[] }>,
  layoutById: Map<string, { triggerIds?: string[] }>
): UIBlueprintTriggerTrace[] {
  return (blueprint.triggers ?? []).map((trigger) => {
    const affectedNodeIds: string[] = [];
    for (const [id, c] of componentById) {
      if ((c.triggerIds ?? []).includes(trigger.id)) affectedNodeIds.push(id);
    }
    for (const [id, l] of layoutById) {
      if ((l.triggerIds ?? []).includes(trigger.id)) affectedNodeIds.push(id);
    }

    if (trigger.enabled === false) {
      return {
        id: trigger.id,
        name: trigger.name,
        expression: trigger.expression,
        status: "inactive",
        result: false,
        dependencies: collectDependencies(trigger),
        affectedNodeIds,
      };
    }

    try {
      const conditionResult = evaluateTriggerConditions(trigger, state);
      const expressionResult = trigger.expression
        ? Boolean(evaluateExpression(trigger.expression, state))
        : true;

      const result = conditionResult && expressionResult;
      return {
        id: trigger.id,
        name: trigger.name,
        expression: trigger.expression,
        status: result ? "active" : "inactive",
        result,
        dependencies: collectDependencies(trigger),
        affectedNodeIds,
      };
    } catch (error) {
      return {
        id: trigger.id,
        name: trigger.name,
        expression: trigger.expression,
        status: "error",
        result: null,
        dependencies: collectDependencies(trigger),
        affectedNodeIds,
        error: error instanceof Error ? error.message : "Unknown trigger evaluation error",
      };
    }
  });
}

function evaluateTriggerConditions(trigger: UIBlueprintTrigger, state: GameState): boolean {
  const conditions = trigger.conditions ?? [];
  if (conditions.length === 0) return true;

  const logic = trigger.conditionLogic ?? "all";
  if (logic === "all") {
    return conditions.every((condition) => evaluateCondition(condition, state));
  }
  return conditions.some((condition) => evaluateCondition(condition, state));
}

function evaluateCondition(condition: UIBlueprintCondition, state: GameState): boolean {
  const current = state.variables[condition.variableId];
  if (current === undefined) return false;
  const target = condition.value;

  switch (condition.operator) {
    case "eq":
      return current === target;
    case "neq":
      return current !== target;
    case "gt":
      return typeof current === "number" && typeof target === "number" ? current > target : false;
    case "gte":
      return typeof current === "number" && typeof target === "number" ? current >= target : false;
    case "lt":
      return typeof current === "number" && typeof target === "number" ? current < target : false;
    case "lte":
      return typeof current === "number" && typeof target === "number" ? current <= target : false;
    case "contains":
      return typeof current === "string" && typeof target === "string" ? current.includes(target) : false;
    default:
      return false;
  }
}

function evaluateVisibility(
  baseVisible: boolean,
  triggerIds: string[],
  triggerLogic: "all" | "any",
  whenExpression: string | undefined,
  state: GameState,
  triggerStatusById: Map<string, UIBlueprintTriggerTrace>,
  errors: string[],
  contextId: string
): boolean {
  if (!baseVisible) return false;

  let triggerGate = true;
  if (triggerIds.length > 0) {
    const triggerResults = triggerIds.map((id) => {
      const trace = triggerStatusById.get(id);
      if (!trace) {
        errors.push(`${contextId} references unknown trigger \"${id}\"`);
        return false;
      }
      return trace.status === "active";
    });

    triggerGate = triggerLogic === "all"
      ? triggerResults.every(Boolean)
      : triggerResults.some(Boolean);
  }

  let expressionGate = true;
  if (whenExpression) {
    try {
      expressionGate = Boolean(evaluateExpression(whenExpression, state));
    } catch (error) {
      errors.push(
        `${contextId} has invalid when expression: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
      expressionGate = false;
    }
  }

  return triggerGate && expressionGate;
}

function resolveBindingValue(
  binding: UIBlueprintBinding,
  state: GameState,
  errors: string[]
): unknown {
  const rawValue = readValueFromPath(binding.path, state);
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return binding.fallback;
  }

  switch (binding.transform) {
    case "string":
      return String(rawValue);
    case "number": {
      const num = Number(rawValue);
      return Number.isFinite(num) ? num : binding.fallback;
    }
    case "boolean":
      return Boolean(rawValue);
    case "percent": {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) return binding.fallback;
      const pct = num <= 1 && num >= 0 ? num * 100 : num;
      return Math.max(0, Math.min(100, pct));
    }
    case "jsonArrayLength": {
      if (Array.isArray(rawValue)) return rawValue.length;
      if (typeof rawValue === "string") {
        try {
          const parsed = JSON.parse(rawValue);
          return Array.isArray(parsed) ? parsed.length : binding.fallback;
        } catch {
          return binding.fallback;
        }
      }
      return binding.fallback;
    }
    default:
      if (binding.transform && !["string", "number", "boolean", "percent", "jsonArrayLength"].includes(binding.transform)) {
        errors.push(`Unsupported binding transform \"${binding.transform}\" for ${binding.id}`);
      }
      return rawValue;
  }
}

function readValueFromPath(path: string, state: GameState): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("vars")) {
    const segments = parsePathSegments(trimmed.slice(4));
    let cursor: unknown = state.variables;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;

      if (cursor === state.variables) {
        const direct = (cursor as Record<string, unknown>)[segment];
        if (direct !== undefined) {
          cursor = direct;
          continue;
        }

        if (i === 0) {
          const remainder = segments.join(".");
          const fullKey = (state.variables as Record<string, unknown>)[remainder];
          if (fullKey !== undefined) return fullKey;
        }
      }

      if (typeof cursor === "string") {
        try {
          cursor = JSON.parse(cursor);
        } catch {
          return undefined;
        }
      }

      if (cursor && typeof cursor === "object") {
        cursor = (cursor as Record<string, unknown>)[segment];
      } else {
        return undefined;
      }
    }

    return cursor;
  }

  if (trimmed === "turnCount") return state.turnCount;
  if (trimmed === "worldId") return state.worldId;
  return undefined;
}

function parsePathSegments(rest: string): string[] {
  const input = rest.trim();
  if (!input) return [];

  const segments: string[] = [];
  const tokenRegex = /\.([A-Za-z0-9_-]+)|\[['\"]([^'\"]+)['\"]\]/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(input))) {
    segments.push((match[1] ?? match[2] ?? "").trim());
  }

  if (segments.length === 0 && input.startsWith(".")) {
    const single = input.slice(1).trim();
    if (single) segments.push(single);
  }

  return segments;
}

function collectDependencies(trigger: UIBlueprintTrigger): string[] {
  const deps = new Set<string>();

  for (const cond of trigger.conditions ?? []) {
    deps.add(cond.variableId);
  }

  if (trigger.expression) {
    const exprDeps = trigger.expression.match(/vars(?:\[['\"]([^'\"]+)['\"]\]|\.([A-Za-z0-9_-]+))/g) ?? [];
    for (const token of exprDeps) {
      const normalized = token
        .replace(/^vars\./, "")
        .replace(/^vars\[['\"]/, "")
        .replace(/['\"]\]$/, "");
      if (normalized) deps.add(normalized);
    }
  }

  return Array.from(deps);
}

type ExprOperator = "&&" | "||" | "==" | "!=" | ">" | ">=" | "<" | "<=" | "!";

type ExprToken =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "identifier"; value: string }
  | { type: "op"; value: ExprOperator }
  | { type: "lparen" }
  | { type: "rparen" };

function evaluateExpression(expression: string, state: GameState): unknown {
  const tokens = tokenizeExpression(expression);
  let index = 0;

  function peek(): ExprToken | undefined {
    return tokens[index];
  }

  function consume(): ExprToken {
    const token = tokens[index];
    if (!token) throw new Error("Unexpected end of expression");
    index += 1;
    return token;
  }

  function peekOp(): ExprOperator | null {
    const token = peek();
    return token?.type === "op" ? token.value : null;
  }

  function parseOr(): unknown {
    let left = parseAnd();
    while (peekOp() === "||") {
      consume();
      const right = parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  function parseAnd(): unknown {
    let left = parseEquality();
    while (peekOp() === "&&") {
      consume();
      const right = parseEquality();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  function parseEquality(): unknown {
    let left = parseComparison();
    while (peekOp() === "==" || peekOp() === "!=") {
      const op = consume() as Extract<ExprToken, { type: "op" }>;
      const right = parseComparison();
      left = op.value === "==" ? left === right : left !== right;
    }
    return left;
  }

  function parseComparison(): unknown {
    let left = parseUnary();
    while (
      peekOp() === ">" ||
      peekOp() === ">=" ||
      peekOp() === "<" ||
      peekOp() === "<="
    ) {
      const op = consume() as Extract<ExprToken, { type: "op" }>;
      const right = parseUnary();
      const l = Number(left);
      const r = Number(right);
      if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
      if (op.value === ">") left = l > r;
      else if (op.value === ">=") left = l >= r;
      else if (op.value === "<") left = l < r;
      else left = l <= r;
    }
    return left;
  }

  function parseUnary(): unknown {
    if (peekOp() === "!") {
      consume();
      return !Boolean(parseUnary());
    }
    return parsePrimary();
  }

  function parsePrimary(): unknown {
    const token = consume();

    if (token.type === "number" || token.type === "string" || token.type === "boolean") {
      return token.value;
    }

    if (token.type === "identifier") {
      if (token.value === "turnCount") return state.turnCount;
      if (token.value === "worldId") return state.worldId;
      if (token.value.startsWith("vars")) {
        const path = token.value.slice(4);
        return readValueFromPath(`vars${path}`, state);
      }
      return undefined;
    }

    if (token.type === "lparen") {
      const value = parseOr();
      const next = consume();
      if (next.type !== "rparen") {
        throw new Error("Missing closing parenthesis");
      }
      return value;
    }

    throw new Error("Invalid expression token");
  }

  const result = parseOr();
  if (index < tokens.length) {
    throw new Error("Unexpected trailing expression content");
  }
  return result;
}

function tokenizeExpression(expression: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    const twoChar = expression.slice(i, i + 2);
    if (["&&", "||", "==", "!=", ">=", "<="].includes(twoChar)) {
      tokens.push({ type: "op", value: twoChar as ExprOperator });
      i += 2;
      continue;
    }

    if ([">", "<", "!"].includes(ch)) {
      tokens.push({ type: "op", value: ch as ExprOperator });
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
      continue;
    }

    if (ch === "\"" || ch === "'") {
      const quote = ch;
      i += 1;
      let value = "";
      while (i < expression.length && expression[i] !== quote) {
        value += expression[i];
        i += 1;
      }
      if (expression[i] !== quote) {
        throw new Error("Unterminated string literal");
      }
      i += 1;
      tokens.push({ type: "string", value });
      continue;
    }

    if (/[-0-9]/.test(ch)) {
      let numberText = ch;
      i += 1;
      while (i < expression.length && /[0-9.]/.test(expression[i]!)) {
        numberText += expression[i];
        i += 1;
      }
      const value = Number(numberText);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid number literal: ${numberText}`);
      }
      tokens.push({ type: "number", value });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let ident = ch;
      i += 1;
      while (i < expression.length && /[A-Za-z0-9_.$\[\]'"-]/.test(expression[i]!)) {
        ident += expression[i];
        i += 1;
      }

      if (ident === "true" || ident === "false") {
        tokens.push({ type: "boolean", value: ident === "true" });
      } else {
        tokens.push({ type: "identifier", value: ident });
      }
      continue;
    }

    throw new Error(`Unsupported expression character: ${ch}`);
  }

  return tokens;
}

function mapComponentToWidget(
  id: string,
  type: string,
  name: string,
  order: number,
  placement: "header",
  props: Record<string, unknown>
): ResolvedComponent | null {
  switch (type) {
    case "progress": {
      const min = toNumber(props.min, 0);
      const max = toNumber(props.max, 100);
      const value = toNumber(props.value, min);
      const range = max - min;
      const percentage = range > 0 ? Math.max(0, Math.min(100, ((value - min) / range) * 100)) : 0;

      const widget: ResolvedStatBar = {
        id,
        type: "stat-bar",
        name,
        order,
        placement,
        value,
        min,
        max,
        percentage,
        color: typeof props.color === "string" ? props.color : undefined,
        showValue: props.showValue !== false,
        showLabel: props.showLabel !== false,
      };
      return widget;
    }

    case "text":
    case "metric":
    case "badge":
    case "choiceGroup":
    case "table":
    case "form": {
      const value = props.value ?? "";
      const label = typeof props.label === "string" ? props.label : name;
      const hasValue =
        value !== undefined && value !== null && String(value).trim().length > 0;
      const text = typeof props.text === "string"
        ? props.text
        : type === "metric" || type === "badge"
        ? hasValue
          ? String(value)
          : label
        : Array.isArray(props.options)
        ? `${label}: ${(props.options as unknown[]).map(String).join(" | ")}`
        : String(value || label);

      const widget: ResolvedTextDisplay = {
        id,
        type: "text-display",
        name,
        order,
        placement,
        text,
        rawValue: value as string | number | boolean,
        fontSize: props.fontSize === "sm" || props.fontSize === "lg" ? props.fontSize : "md",
        icon: typeof props.icon === "string" ? props.icon : undefined,
        textColor: typeof props.textColor === "string" ? props.textColor : undefined,
      };
      return widget;
    }

    case "image": {
      const widget: ResolvedImagePanel = {
        id,
        type: "image-panel",
        name,
        order,
        placement,
        imageUrl: typeof props.url === "string" ? props.url : "",
        aspectRatio:
          props.aspectRatio === "square" ||
          props.aspectRatio === "portrait" ||
          props.aspectRatio === "wide"
            ? props.aspectRatio
            : "landscape",
        size:
          props.size === "sm" || props.size === "md" || props.size === "lg" || props.size === "full"
            ? props.size
            : "full",
        imagePlacement:
          props.placement === "left" || props.placement === "right" ? props.placement : "center",
        fallbackUrl: typeof props.fallbackUrl === "string" ? props.fallbackUrl : undefined,
      };
      return widget;
    }

    case "list": {
      const rawItems = props.items;
      let items: string[] = [];
      if (Array.isArray(rawItems)) {
        items = rawItems.map(String);
      } else if (typeof rawItems === "string") {
        try {
          const parsed = JSON.parse(rawItems);
          if (Array.isArray(parsed)) items = parsed.map(String);
        } catch {
          items = rawItems
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
        }
      }

      const maxSlots = toNumber(props.maxSlots, 16);
      const widget: ResolvedInventoryGrid = {
        id,
        type: "inventory-grid",
        name,
        order,
        placement,
        items: items.slice(0, maxSlots),
        columns: toNumber(props.columns, 4),
        maxSlots,
      };
      return widget;
    }

    case "webPanel": {
      const widget: ResolvedWebPanel = {
        id,
        type: "web-panel",
        name,
        order,
        placement,
        htmlUrl: typeof props.htmlUrl === "string" ? props.htmlUrl : undefined,
        html: typeof props.html === "string" ? props.html : undefined,
        cssUrl: typeof props.cssUrl === "string" ? props.cssUrl : undefined,
        css: typeof props.css === "string" ? props.css : undefined,
        jsUrl: typeof props.jsUrl === "string" ? props.jsUrl : undefined,
        js: typeof props.js === "string" ? props.js : undefined,
        height: Number.isFinite(Number(props.height))
          ? Number(props.height)
          : undefined,
        sandbox: typeof props.sandbox === "string" ? props.sandbox : undefined,
      };
      return widget;
    }

    default:
      return null;
  }
}

function toNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function makeError(
  id: string,
  name: string,
  order: number,
  placement: "header",
  message: string
): ResolvedError {
  return {
    id,
    type: "error",
    name,
    order,
    placement,
    message,
  };
}
