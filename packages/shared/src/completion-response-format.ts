/** Bounded, optional output contract for raw side completions. */
export type CompletionResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: {
      name: string;
      strict: true;
      schema: Record<string, unknown>;
    } };

const MAX_BYTES = 16_384;
const MAX_DEPTH = 16;
const MAX_VALUES = 2_048;

function invalid(detail: string): never {
  throw new Error(`Invalid responseFormat: ${detail}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Validate transport shape and resource bounds; schema keywords remain the provider's responsibility. */
export function parseCompletionResponseFormat(raw: unknown): CompletionResponseFormat | undefined {
  if (raw === undefined) return undefined;
  let visited = 0;
  const ancestors = new Set<object>();
  // Bound traversal BEFORE JSON.stringify: callers need not have come from JSON.parse.
  function visit(value: unknown, depth: number): void {
    if (++visited > MAX_VALUES) invalid(`more than ${MAX_VALUES} visited values`);
    if (depth > MAX_DEPTH) invalid(`depth exceeds ${MAX_DEPTH}`);
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || value === null) invalid("only JSON values are allowed");
    if (ancestors.has(value)) invalid("cyclic value");
    const array = Array.isArray(value);
    if (array && (Object.getPrototypeOf(value) !== Array.prototype || "toJSON" in value)) {
      invalid("only plain JSON arrays without serialization hooks are allowed");
    }
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      invalid("only plain JSON objects are allowed");
    }
    if (Object.getOwnPropertySymbols(value).length) invalid("symbol keys are not JSON");
    ancestors.add(value);
    const keys = Object.keys(value);
    if (Object.getOwnPropertyNames(value).length !== keys.length + (array ? 1 : 0)) {
      invalid("non-enumerable properties are not plain JSON");
    }
    if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) {
      invalid("only dense JSON arrays are allowed");
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) invalid("accessors are not JSON");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(raw, 0);
  if (!isObject(raw)) invalid("expected an object");
  if (raw.type === "json_object") {
    if (!exactKeys(raw, ["type"])) invalid("unexpected json_object wrapper fields");
  } else if (raw.type === "json_schema") {
    if (!exactKeys(raw, ["type", "json_schema"]) || !isObject(raw.json_schema)) invalid("expected json_schema wrapper");
    const definition = raw.json_schema;
    if (!exactKeys(definition, ["name", "strict", "schema"])) invalid("unexpected json_schema fields");
    if (typeof definition.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(definition.name)) invalid("invalid schema name");
    if (definition.strict !== true) invalid("strict must be true");
    if (!isObject(definition.schema) || definition.schema.type !== "object") invalid("schema root must have type object");
  } else {
    invalid("unsupported type");
  }
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_BYTES) invalid(`serialized format exceeds ${MAX_BYTES} UTF-8 bytes`);
  return raw as CompletionResponseFormat;
}
