// Probe-first additive DDL for the startup self-heal (ensure* in db/index.ts).
//
// Production rule: startup must not take table locks for nothing. Even a no-op
// `ALTER TABLE … ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE before it
// learns the column exists, and on worlds / play_sessions / messages that lock
// queues behind in-flight reads and stalls every request behind it. So each
// ensure* step reads the catalog first and sends only the statements whose
// object is missing — on an up-to-date database, boot sends no DDL at all.
//
// Mirrors scripts/schema-probe.mjs (the pre-deploy copy: the runtime image
// ships scripts/ but not src/, and the discovery cron images ship src/db but
// not scripts/). schema-probe.test.ts keeps the two identical.
/* eslint-disable */

export type SchemaObject =
  | { type: "table"; name: string }
  | { type: "index"; name: string; table: string }
  | { type: "column"; name: string; table: string };

export type StatementKind = "control" | "table" | "index" | "columns" | "backfill" | "unprobed";

export interface ClassifiedStatement {
  kind: StatementKind;
  text: string;
  objects: SchemaObject[];
  concurrently?: boolean;
}

export interface SqlSource { name: string; sql: string }

export type CatalogQuery = (text: string) => Promise<{ rows: Record<string, unknown>[] }>;

/** Split SQL into top-level statements, respecting quotes, dollar quotes and comments. */
export function splitSqlStatements(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? text.length : end + tag[0].length;
        current += text.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?`;

function identName(raw: string): string {
  const last = (raw.split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/).pop() ?? raw).trim();
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Classify one statement:
 * - control  BEGIN / COMMIT / SET / SELECT — dropped; the runner owns the transaction
 * - table    CREATE TABLE IF NOT EXISTS t
 * - index    CREATE [UNIQUE] INDEX [CONCURRENTLY] IF NOT EXISTS i ON t
 * - columns  ALTER TABLE t ADD COLUMN IF NOT EXISTS c[, ADD COLUMN IF NOT EXISTS c2 …]
 * - backfill UPDATE … — data that goes with a column; runs only when DDL in the same source runs
 * - unprobed anything else (DO blocks, ALTER COLUMN, functions) — the probe cannot prove it done
 */
export function classifyStatement(statement: string): ClassifiedStatement {
  const text = statement.replace(/\s+/g, " ").trim();
  if (/^(BEGIN|COMMIT|START TRANSACTION|SET |SELECT )/i.test(text) || /^(BEGIN|COMMIT)$/i.test(text)) {
    return { kind: "control", text: statement, objects: [] };
  }
  let m = new RegExp(`^CREATE TABLE IF NOT EXISTS (${IDENT})`, "i").exec(text);
  if (m) return { kind: "table", text: statement, objects: [{ type: "table", name: identName(m[1]!) }] };
  m = new RegExp(`^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?IF NOT EXISTS (${IDENT}) ON (?:ONLY )?(${IDENT})`, "i").exec(text);
  if (m) {
    return {
      kind: "index", text: statement, concurrently: Boolean(m[1]),
      objects: [{ type: "index", name: identName(m[2]!), table: identName(m[3]!) }],
    };
  }
  m = new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${IDENT}) (.+)$`, "i").exec(text);
  if (m) {
    const table = identName(m[1]!);
    const objects: SchemaObject[] = [];
    for (const action of splitTopLevelCommas(m[2]!)) {
      const col = new RegExp(`^ADD COLUMN IF NOT EXISTS (${IDENT})`, "i").exec(action);
      if (!col) return { kind: "unprobed", text: statement, objects: [] };
      objects.push({ type: "column", table, name: identName(col[1]!) });
    }
    return { kind: "columns", text: statement, objects };
  }
  if (/^UPDATE /i.test(text)) return { kind: "backfill", text: statement, objects: [] };
  return { kind: "unprobed", text: statement, objects: [] };
}

export function parseAdditiveSql(text: string): ClassifiedStatement[] {
  return splitSqlStatements(text).map(classifyStatement);
}

export function objectLabel(object: SchemaObject): string {
  return object.type === "column" ? `column ${object.table}.${object.name}` : `${object.type} ${object.name}`;
}

const literal = (value: string): string => `'${String(value).replace(/'/g, "''")}'`;
const list = (values: string[]): string => [...new Set(values)].map(literal).join(", ");

/**
 * Which of these objects does the current schema lack? Catalog reads only —
 * information_schema and pg_indexes take no lock on the tables they describe.
 * `query(text)` returns `{ rows }` (node-postgres Client and PGlite both do).
 */
export async function findMissingObjects(query: CatalogQuery, objects: SchemaObject[]): Promise<SchemaObject[]> {
  const tables = objects.filter((o) => o.type === "table").map((o) => o.name);
  const columnTables = objects.flatMap((o) => (o.type === "column" ? [o.table] : []));
  const indexes = objects.filter((o) => o.type === "index").map((o) => o.name);
  const presentTables = new Set<unknown>();
  const presentColumns = new Set<string>();
  const presentIndexes = new Set<unknown>();
  if (tables.length) {
    const { rows } = await query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN (${list(tables)})`);
    for (const row of rows) presentTables.add(row.table_name);
  }
  if (columnTables.length) {
    const { rows } = await query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN (${list(columnTables)})`);
    for (const row of rows) presentColumns.add(`${String(row.table_name)}.${String(row.column_name)}`);
  }
  if (indexes.length) {
    const { rows } = await query(`SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname IN (${list(indexes)})`);
    for (const row of rows) presentIndexes.add(row.indexname);
  }
  return objects.filter((o) => {
    if (o.type === "table") return !presentTables.has(o.name);
    if (o.type === "column") return !presentColumns.has(`${o.table}.${o.name}`);
    return !presentIndexes.has(o.name);
  });
}

/**
 * Plan a set of SQL sources against the live catalog. Returns the statements
 * that still need to run (in source order) and what is missing. A source with
 * an unprobed statement cannot be proven complete, so it runs whole.
 */
export async function planAdditiveSql(
  query: CatalogQuery,
  sources: SqlSource[],
): Promise<{ missing: string[]; unprobed: string[]; run: ClassifiedStatement[] }> {
  const parsed = sources.map((source) => ({ ...source, statements: parseAdditiveSql(source.sql) }));
  const objects = parsed.flatMap((source) => source.statements.flatMap((s) => s.objects));
  const missing = await findMissingObjects(query, objects);
  const missingKeys = new Set(missing.map(objectLabel));
  const run: ClassifiedStatement[] = [];
  const unprobed: string[] = [];
  for (const source of parsed) {
    const whole = source.statements.some((s) => s.kind === "unprobed");
    if (whole) unprobed.push(source.name);
    const needed = source.statements.filter((s) =>
      s.kind !== "control" && s.kind !== "backfill" && (whole || s.objects.some((o) => missingKeys.has(objectLabel(o)))));
    if (!needed.length) continue;
    // A backfill belongs to the DDL beside it: run it only when that DDL runs.
    run.push(...source.statements.filter((s) => s.kind !== "control" && (needed.includes(s) || s.kind === "backfill")));
  }
  return { missing: missing.map(objectLabel), unprobed, run };
}
