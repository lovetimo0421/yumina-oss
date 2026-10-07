/**
 * Which variables does a card's frontend actually read?
 *
 * The canvas can show every wire the schema stores, but the most expensive
 * class of card bug lives outside the schema: a HUD bound to a variable that
 * nothing ever writes, or a variable nobody displays. The binding lives in
 * TSX, so we read the TSX — the same regex approach `lore-slot-scan.ts` uses
 * for LoreSlot ids, for the same reason (no parser in the engine, and the
 * access patterns the docs teach are shallow and stable).
 *
 * Reads are keyed by variable NAME, because that is what the sandbox bridge
 * exposes (`api.variables.<name>`). The caller maps names to ids.
 */

export interface VariableReadScan {
  /** Variable names read with a statically known key, deduped and sorted. */
  names: string[];
  /** Reads whose key is computed at runtime (`api.variables[key]`). We can't
   *  name these — reporting the count beats pretending the scan was total. */
  dynamicReads: number;
  /** Variables the frontend writes itself, via `api.setVariable("name", …)`. */
  writes: string[];
  /** `setVariable` calls whose target is computed. Any of these means "this
   *  card's frontend might write anything" — callers must not claim a
   *  variable is unwritten when this is non-zero. */
  dynamicWrites: number;
}

/** `api.variables` / `yumina.variables` / `window.yumina.variables`, plus the
 *  `props.variables` a couple of cards reach it through. Case matters: it is
 *  what keeps `api.globalVariables` out. */
const ROOT_SOURCE = String.raw`(?:window\s*\.\s*)?(?:api|yumina|props)\s*\.\s*variables`;

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const IDENT_ONLY = new RegExp(`^${IDENT}$`);

/** Names bound to the variables bag in this file: `const v = api.variables`
 *  and the `const { variables } = useYumina()` form the docs teach. */
function aliasesIn(source: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;

  // Only a binding of the WHOLE bag is an alias. Real cards are written as one
  // const per field (`const day = api.variables['day-count']`); reading those
  // as aliases turned every `.length` and `.filter()` on them into a phantom
  // variable read, so anything that keeps indexing disqualifies the binding.
  const direct = new RegExp(
    String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*${ROOT_SOURCE}\s*(?![.[\w$])`,
    "g",
  );
  while ((m = direct.exec(source)) !== null) found.add(m[1]!);

  const hook = new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*useYumina\s*\(`, "g");
  while ((m = hook.exec(source)) !== null) {
    for (const part of m[1]!.split(",")) {
      const [rawKey, rawAlias] = part.split(":");
      if (rawKey?.trim() !== "variables") continue;
      const bound = (rawAlias ?? rawKey).trim().split("=")[0]!.trim();
      if (IDENT_ONLY.test(bound)) found.add(bound);
    }
  }
  return [...found];
}

/** Destructured keys, resolving `key: local` to `key` and dropping rest/defaults. */
function destructuredKeys(inner: string): string[] {
  const out: string[] = [];
  for (const part of inner.split(",")) {
    const raw = part.trim();
    if (!raw || raw.startsWith("...")) continue;
    const key = raw.split(":")[0]!.split("=")[0]!.trim();
    if (IDENT_ONLY.test(key)) out.push(key);
  }
  return out;
}

export function extractVariableReadsFromFiles(files: Record<string, string>): VariableReadScan {
  const names = new Set<string>();
  const writes = new Set<string>();
  let dynamicReads = 0;
  let dynamicWrites = 0;

  // A card's own UI can drive its state (`api.setVariable`). Missing that
  // would make every frontend-driven variable look unwritten.
  const setLiteral = new RegExp(String.raw`\bsetVariable\s*\(\s*["'\`]([^"'\`]+)["'\`]`, "g");
  const setComputed = new RegExp(String.raw`\bsetVariable\s*\(\s*(?!["'\`])`, "g");
  for (const source of Object.values(files)) {
    if (typeof source !== "string" || !source.includes("setVariable")) continue;
    let w: RegExpExecArray | null;
    while ((w = setLiteral.exec(source)) !== null) writes.add(w[1]!);
    while (setComputed.exec(source) !== null) dynamicWrites++;
  }

  for (const source of Object.values(files)) {
    if (typeof source !== "string") continue;
    if (!source.includes("variables")) continue;

    const roots = [
      ROOT_SOURCE,
      ...aliasesIn(source).map((a) => String.raw`\b${a.replace(/\$/g, String.raw`\$`)}\b`),
    ];
    const root = `(?:${roots.join("|")})`;

    let m: RegExpExecArray | null;

    const dotted = new RegExp(String.raw`${root}\s*\.\s*(${IDENT})`, "g");
    while ((m = dotted.exec(source)) !== null) names.add(m[1]!);

    const bracketed = new RegExp(String.raw`${root}\s*\[\s*["']([^"']+)["']\s*\]`, "g");
    while ((m = bracketed.exec(source)) !== null) names.add(m[1]!);

    const computed = new RegExp(String.raw`${root}\s*\[\s*(?!["'])`, "g");
    while (computed.exec(source) !== null) dynamicReads++;

    const destructured = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${root}\b`, "g");
    while ((m = destructured.exec(source)) !== null) {
      for (const key of destructuredKeys(m[1]!)) names.add(key);
    }
  }

  return { names: [...names].sort(), dynamicReads, writes: [...writes].sort(), dynamicWrites };
}
