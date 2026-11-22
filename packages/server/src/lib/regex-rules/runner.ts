/**
 * The player's regex rules on what the AI is sent (shared/src/regex-rules.ts). Rules live in the account's AI
 * settings; the ones marked "sent to the AI" rewrite the history of each turn before it is sent. Saved messages
 * never change.
 *
 * A player can write a rule that takes exponential time on some text. It runs in a worker thread with a time
 * limit: past it the worker is replaced and the turn goes out with the history unchanged, so no rule can stall
 * the server.
 */
import { Worker } from "node:worker_threads";
import { sql } from "drizzle-orm";
import { regexRulesSchema, type RegexRule } from "@yumina/shared";
import { readOwn } from "../../db/index.js";
import { user } from "../../db/schema.js";
import type { RegexJob, RegexOutcome } from "./worker.js";

const JOB_TIMEOUT_MS = 400;
/** A worker that is still starting (loading its code) gets this long instead: start-up is not the rules' fault. */
const STARTING_TIMEOUT_MS = 5_000;
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; rules: RegexRule[] }>();
let worker: Worker | null = null;
let workerOnline = false;
let nextJobId = 1;

/** Forget a player's cached rules (they just saved new ones). */
export function invalidateRegexRules(userId: string): void {
  cache.delete(userId);
}

/** The player's enabled rules that apply to what the AI is sent. */
export async function loadPromptRegexRules(userId: string): Promise<RegexRule[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules;
  let rules: RegexRule[] = [];
  try {
    const rd = await readOwn(userId);
    const [row] = await rd.select({ rules: sql<unknown>`${user.preferences}->'aiConfig'->'regexRules'` })
      .from(user).where(sql`${user.id} = ${userId}`).limit(1);
    const parsed = regexRulesSchema.safeParse(row?.rules ?? []);
    rules = parsed.success ? parsed.data.filter((r) => r.enabled && r.prompt) : [];
  } catch (err) {
    console.warn("[regex-rules] could not read rules:", err instanceof Error ? err.message : err);
  }
  cache.set(userId, { at: Date.now(), rules });
  if (cache.size > 5_000) cache.delete(cache.keys().next().value!);
  return rules;
}

function workerUrl(): URL {
  // Built: dist/index.js beside dist/regex-rules-worker.js (tsup entry). Dev (tsx): beside worker.ts.
  return import.meta.url.endsWith(".ts")
    ? new URL("./worker.ts", import.meta.url)
    : new URL("./regex-rules-worker.js", import.meta.url);
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(workerUrl());
  workerOnline = false;
  w.once("online", () => { if (worker === w) workerOnline = true; });
  w.unref();
  w.on("error", (err) => console.error("[regex-rules] worker error:", err instanceof Error ? err.message : err));
  w.on("exit", () => { if (worker === w) worker = null; });
  worker = w;
  return w;
}

function runInWorker(job: Omit<RegexJob, "id">): Promise<string[] | null> {
  return new Promise((resolve) => {
    const w = getWorker();
    const id = nextJobId++;
    const done = (contents: string[] | null) => {
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("exit", onExit);
      resolve(contents);
    };
    const onMessage = (outcome: RegexOutcome) => { if (outcome.id === id) done(outcome.contents); };
    const onExit = () => done(null);
    const limit = workerOnline ? JOB_TIMEOUT_MS : STARTING_TIMEOUT_MS;
    const timer = setTimeout(() => {
      console.warn(`[regex-rules] rules took over ${limit}ms; history sent unchanged, worker restarted`);
      // Forget it now: its exit event comes later, and the next turn must not be handed the dying worker.
      if (worker === w) worker = null;
      void w.terminate();
      done(null);
    }, limit);
    w.on("message", onMessage);
    w.on("exit", onExit);
    w.postMessage({ id, ...job } satisfies RegexJob);
  });
}

/**
 * The history rows with the player's "sent to the AI" rules applied, oldest first as given. Rows without rules,
 * or a run that failed or timed out, come back unchanged.
 */
export async function applyPromptRegexRules<T extends { role: string; content: string }>(userId: string, rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  const rules = await loadPromptRegexRules(userId);
  if (rules.length === 0) return rows;
  const contents = await runInWorker({ rules, rows: rows.map((r) => ({ role: r.role, content: r.content })) });
  if (!contents || contents.length !== rows.length) return rows;
  return rows.map((row, i) => (contents[i] === row.content ? row : { ...row, content: contents[i]! }));
}

/** Test hook: run rules through the real worker and time limit, without the account read. */
export function applyRegexRulesInWorkerForTest(rows: Array<{ role: string; content: string }>, rules: RegexRule[]): Promise<string[] | null> {
  return runInWorker({ rules, rows });
}
