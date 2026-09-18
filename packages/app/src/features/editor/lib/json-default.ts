import type { Variable } from "@yumina/engine";

export function parseJsonDefault(text: string): Record<string, unknown> | unknown[] {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") throw new Error("objectOrArray");
  return value as Record<string, unknown> | unknown[];
}

// Object key order is not semantic; array order is. A server JSONB round trip
// must not make us discard the author's original text.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

export function jsonDefaultText(variable: Pick<Variable, "defaultValue" | "defaultValueText">): string {
  if (variable.defaultValueText !== undefined) {
    try {
      if (canonical(parseJsonDefault(variable.defaultValueText)) === canonical(variable.defaultValue)) {
        return variable.defaultValueText;
      }
    } catch {
      // Keep unfinished edits available across selection switches and undo.
      return variable.defaultValueText;
    }
  }
  return typeof variable.defaultValue === "string"
    ? variable.defaultValue
    : JSON.stringify(variable.defaultValue, null, 2);
}

export function jsonDefaultUpdate(text: string): Partial<Variable> {
  try {
    return { defaultValueText: text, defaultValue: parseJsonDefault(text) };
  } catch {
    return { defaultValueText: text };
  }
}

export function invalidJsonDefault(variables: Variable[]): Variable | undefined {
  return variables.find((variable) => {
    if (variable.type !== "json" || variable.defaultValueText === undefined) return false;
    try { parseJsonDefault(variable.defaultValueText); return false; } catch { return true; }
  });
}
