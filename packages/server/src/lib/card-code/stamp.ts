/**
 * Cards whose code reaches players without a precompiled copy get one, once.
 *
 * The editor stamps `rootComponent.compiled` at save, but most other writers
 * of worlds.schema do not (the Studio assistant, imports, collab, version
 * restores, admin scripts), and until 2026-10-29 the editor itself skipped any
 * card whose code merely mentioned "data:x/". Half the published cards with
 * code had no stamp, so every player's browser compiled them on every open:
 * up to three seconds on a phone for the heaviest.
 *
 * So the play paths hand the live row here. A card with no current stamp is
 * compiled in a worker thread (same compiler as the editor, same bytes) and
 * the result is written back into the row, guarded so it only lands while the
 * card's code is still exactly what was compiled. updated_at is untouched: a
 * stamp is not an edit, and must not trip the editor's stale-save check.
 * The player who triggered it compiles live as before; the next one does not.
 */
import { Worker } from "node:worker_threads";
import { sql } from "drizzle-orm";
import { COMPILED_FORMAT_VERSION } from "@yumina/shared";
import { db } from "../../db/index.js";
import type { CompileJob, CompileOutcome } from "./worker.js";

/** Queued rows hold their files (a few MB each on the heaviest cards), so the
 *  queue stays short; a card that misses it is queued by its next player. */
const MAX_QUEUE = 25;
/** One card's compile; past this the worker is stuck and is replaced. */
const JOB_TIMEOUT_MS = 30_000;
/** A card that would not compile (or carries an embedded file) is not retried
 *  for this long, unless its code changes. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

interface Pending {
  worldId: string;
  /** worlds.updated_at of the row the files came from: the dedupe key. */
  version: string;
  entryFile: string;
  files: Record<string, string>;
}

const queue: Pending[] = [];
const inFlight = new Set<string>();
const givenUp = new Map<string, number>();
let worker: Worker | null = null;
let running = false;
let nextJobId = 1;

function disabled(): boolean {
  return process.env.CARD_CODE_STAMP === "off";
}

function workerUrl(): URL {
  // Built: dist/index.js beside dist/card-code-worker.js (tsup entry).
  // Dev (tsx): this file beside worker.ts.
  return import.meta.url.endsWith(".ts")
    ? new URL("./worker.ts", import.meta.url)
    : new URL("./card-code-worker.js", import.meta.url);
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(workerUrl());
  w.unref();
  w.on("error", (err) => {
    console.error("[card-code] worker error:", err instanceof Error ? err.message : err);
  });
  w.on("exit", () => {
    if (worker === w) worker = null;
  });
  worker = w;
  return w;
}

function compileInWorker(job: Omit<CompileJob, "id">): Promise<CompileOutcome | null> {
  return new Promise((resolve) => {
    const w = getWorker();
    const id = nextJobId++;
    const done = (outcome: CompileOutcome | null) => {
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("exit", onExit);
      resolve(outcome);
    };
    const onMessage = (outcome: CompileOutcome) => {
      if (outcome.id === id) done(outcome);
    };
    const onExit = () => done(null);
    const timer = setTimeout(() => {
      console.warn(`[card-code] compile took over ${JOB_TIMEOUT_MS}ms; restarting the worker`);
      void w.terminate();
      done(null);
    }, JOB_TIMEOUT_MS);
    w.on("message", onMessage);
    w.on("exit", onExit);
    w.postMessage({ id, ...job } satisfies CompileJob);
  });
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const key = `${item.worldId}@${item.version}`;
      try {
        const outcome = await compileInWorker({ entryFile: item.entryFile, files: item.files });
        if (!outcome?.compiled) {
          givenUp.set(key, Date.now());
          if (outcome?.skipped !== "embedded-file") {
            console.warn(`[card-code] ${item.worldId} did not compile; players keep compiling it live`);
          }
          continue;
        }
        const written = await db.execute(sql`
          UPDATE worlds
             SET schema = jsonb_set(schema, '{rootComponent,compiled}', ${JSON.stringify(outcome.compiled)}::jsonb, true)
           WHERE id = ${item.worldId}
             AND schema->'rootComponent'->'files' = ${outcome.filesJson}::jsonb
             AND coalesce(nullif(schema->'rootComponent'->>'entryFile', ''), 'index.tsx') = ${item.entryFile}
             AND ((schema->'rootComponent'->'compiled'->>'compilerVersion') IS DISTINCT FROM ${String(COMPILED_FORMAT_VERSION)}
               OR (schema->'rootComponent'->'compiled'->>'filesHash') IS DISTINCT FROM ${outcome.compiled.filesHash})
        `);
        const count = (written as { rowCount?: number | null }).rowCount ?? 0;
        if (count > 0) console.info(`[card-code] stamped ${item.worldId} (${outcome.ms}ms)`);
        // No row: the code changed meanwhile (its new version gets its own key),
        // another instance stamped it, or the guard can never match this row.
        // Either way, not again for this version: a guard that never matches
        // must not mean a compile on every read.
        else givenUp.set(key, Date.now());
      } catch (err) {
        givenUp.set(key, Date.now());
        console.error(`[card-code] stamping ${item.worldId} failed:`, err instanceof Error ? err.message : err);
      } finally {
        inFlight.delete(key);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Queue the live row's code for a stamp when it has none for the current
 * compiler. Cheap on the request thread: no hashing, no stringify. A stamp
 * whose source no longer matches is left to the client's hash check (it
 * compiles live), which is the editor's own fallback.
 */
export function stampCompiledLater(
  world: { id: string; updatedAt: Date | string | null; schema: unknown },
  /** stale: the current stamp was found not to match the source (see
   *  source.ts), so a current compiler version is no reason to skip it. */
  opts: { stale?: boolean } = {},
): void {
  if (disabled()) return;
  const rc = (world.schema as { rootComponent?: { entryFile?: unknown; files?: unknown; compiled?: { compilerVersion?: unknown } } } | null)?.rootComponent;
  const files = rc?.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length === 0) return;
  if (!opts.stale && rc.compiled?.compilerVersion === COMPILED_FORMAT_VERSION) return;
  if (!Object.values(files).every((code) => typeof code === "string")) return;

  const version = world.updatedAt instanceof Date ? world.updatedAt.toISOString() : String(world.updatedAt ?? "");
  const key = `${world.id}@${version}`;
  if (inFlight.has(key)) return;
  if (givenUp.size > 5000) givenUp.clear();
  const gaveUpAt = givenUp.get(key);
  if (gaveUpAt && Date.now() - gaveUpAt < RETRY_AFTER_MS) return;
  if (queue.length >= MAX_QUEUE) return;

  inFlight.add(key);
  queue.push({
    worldId: world.id,
    version,
    entryFile: typeof rc.entryFile === "string" && rc.entryFile ? rc.entryFile : "index.tsx",
    files: files as Record<string, string>,
  });
  void drain();
}
