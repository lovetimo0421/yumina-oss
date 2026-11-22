/**
 * The card translator's checks run the card's own regexes (the formats its interface parses, the keyword scans it
 * tests values with) against card text and model output. A card can hold a pattern that backtracks for minutes on
 * the wrong line (/^【(\w|\w)*】$/ on an unclosed bracket); on the main thread that stalls the whole server.
 *
 * Here they run in a worker, one per translation job. The worker stamps each pattern evaluation into shared memory;
 * one that runs past PATTERN_MS, or a job step past its own limit, gets the worker stopped and replaced, and the
 * step is run again without that pattern. The pattern is then unusable for the rest of the job (its format is
 * simply not checked). Once the job has lost budgetMs to such stops, or its steps have used totalMs in all (many
 * evaluations each just under the limit), every card pattern is dropped. A card whose patterns are all fast gets
 * exactly the results the plain functions give.
 */
import { Worker } from "node:worker_threads";
import {
  cardLiterals, codeFiles, formatMarkers, lostMarkers, lostPatterns, patternSample, restoreMarkers,
  type CardLiterals, type MarkerPattern,
} from "../card-translate-literals.js";
import { CLOCK_BYTES, CLOCK_KEY_LENGTH, CLOCK_RUNNING, type PatternCheck, type PatternJobBody, type PatternOutcome } from "./protocol.js";

export interface PatternLimits {
  /** One evaluation of one pattern (a test over a text, a line, a value). */
  patternMs: number;
  /** One step (check a text, restore a text, list markers). */
  stepMs: number;
  /** Reading the card's code (a babel parse of every interface file). */
  literalsMs: number;
  /** Time a job may lose to stopped patterns before it drops them all. */
  budgetMs: number;
  /** Worker time a job may use on card patterns in all before it drops them (normal cards use milliseconds). */
  totalMs: number;
  /** Starting the worker (loading its code) is not a pattern's fault and gets its own allowance. */
  startMs: number;
}

const DEFAULT_LIMITS: PatternLimits = { patternMs: 500, stepMs: 10_000, literalsMs: 30_000, budgetMs: 5_000, totalMs: 60_000, startMs: 30_000 };
/** A text longer than this is not run through card patterns at all. */
export const MAX_PATTERN_TEXT = 200_000;
/** Steps re-run after a stop, each without the pattern that was stopped. */
const MAX_ATTEMPTS = 4;

type CallResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: "timeout"; culprit: string | null; elapsed: number }
  | { ok: false; kind: "error" | "unavailable"; message: string };

/** A pattern the card's code wrote (src "/…/flags"); markers built from compared strings are escaped literals. */
const fromCode = (p: MarkerPattern) => p.src.startsWith("/");

function spawn(workerData: { buffer: SharedArrayBuffer }): Worker {
  // Built: dist/index.js beside dist/card-translate-regex-worker.js (tsup entry).
  if (!import.meta.url.endsWith(".ts")) return new Worker(new URL("./card-translate-regex-worker.js", import.meta.url), { workerData });
  // Dev and tests (tsx): a worker does not inherit tsx's loader, and worker.ts imports ../card-translate-literals.js,
  // so register tsx inside the worker first (as rules-check/run.ts does).
  const api = import.meta.resolve("tsx/esm/api");
  const entry = new URL("./worker.ts", import.meta.url).href;
  return new Worker(`import(${JSON.stringify(api)}).then((t) => { t.register(); return import(${JSON.stringify(entry)}); });`, { eval: true, workerData });
}

const emptyLiterals = (): CardLiterals => ({ values: new Set(), keys: new Set(), patterns: [], scans: [], listed: new Set() });

export class CardPatternRunner {
  /** Card patterns (RegExp source) dropped in this job because they ran too long. */
  readonly skipped: string[] = [];
  /** Plain-language notes for the job report. */
  readonly notes: string[] = [];
  private readonly dead = new Set<string>();
  private allDead = false;
  private spent = 0;
  private used = 0;
  private broken = false;
  private worker: Worker | null = null;
  private ready: Promise<Worker | null> | null = null;
  private clock = new SharedArrayBuffer(CLOCK_BYTES);
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private readonly limits: PatternLimits;

  constructor(limits: Partial<PatternLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** The patterns still in use: escaped literals always, card patterns unless stopped (or all dropped). */
  usable(patterns: MarkerPattern[]): MarkerPattern[] {
    return patterns.filter((p) => !fromCode(p) || (!this.allDead && !this.dead.has(p.re.source)));
  }

  /** cardLiterals(), with the card's patterns evaluated in the worker. */
  async literals(schema: Record<string, any>): Promise<CardLiterals> {
    // No interface code, no card regexes: nothing here can run long, and no worker is started.
    if (!codeFiles(schema).length) return cardLiterals(schema);
    const slim = {
      rootComponent: { files: schema.rootComponent?.files ?? {} },
      customComponents: schema.customComponents, messageRenderer: schema.messageRenderer,
      variables: schema.variables, rules: schema.rules, reactions: schema.reactions,
    };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await this.call({ op: "literals", schema: slim, skip: [...this.dead], skipAll: this.allDead }, this.limits.literalsMs);
      if (r.ok) return r.value as CardLiterals;
      if (r.kind !== "timeout") break;
      if (!r.culprit && this.allDead) {
        // Slow with no pattern running: the code itself is too big to read in time. Nothing the code matches is
        // protected; the job goes on (and reports it) rather than stall here.
        this.notes.push("the card's interface code took too long to read; code-matched values and formats were not protected");
        return emptyLiterals();
      }
      this.blame(r);
    }
    // No worker: read the code here, but without running any card pattern (formats and scans are not checked).
    this.allDead = true;
    this.notes.push("card code regexes were not checked (their worker was unavailable)");
    try { return cardLiterals(schema, { all: true }); } catch { return emptyLiterals(); }
  }

  /** formatMarkers() over the card's texts. */
  markers(texts: Array<{ text: string; facing: boolean }>, patterns: MarkerPattern[]): Promise<string[]> {
    return this.step(patterns, texts.map((t) => t.text),
      (ps) => ({ op: "markers", texts, patterns: ps }),
      (ps) => formatMarkers(texts, ps));
  }

  /** Patterns the translation matches less often than the source (with a sample line), and markers it lost. */
  check(src: string, out: string, patterns: MarkerPattern[], opening: boolean): Promise<PatternCheck> {
    return this.step(patterns, [src, out],
      (ps) => ({ op: "check", src, out, patterns: ps, opening }),
      (ps) => ({ lost: lostPatterns(src, out, ps, opening).map((p) => ({ src: p.src, sample: patternSample(src, p) })), markers: lostMarkers(src, out, ps) }));
  }

  /** restoreMarkers(). */
  restore(src: string, out: string, lit: CardLiterals, opening: boolean): Promise<{ text: string; restored: number }> {
    return this.step(lit.patterns, [src, out],
      (ps) => ({ op: "restore", src, out, patterns: ps, keys: [...lit.keys], opening }),
      (ps) => restoreMarkers(src, out, { ...lit, patterns: ps }, opening));
  }

  close(): void {
    this.broken = true;
    this.kill();
  }

  /**
   * Run a step in the worker with the patterns still usable; after a stop, again without the pattern that was
   * running. With no card pattern left (or a text too long to run them on) it runs here, where only escaped
   * literals and the module's own fixed regexes are evaluated.
   */
  private async step<T>(patterns: MarkerPattern[], texts: string[], job: (ps: MarkerPattern[]) => PatternJobBody, local: (ps: MarkerPattern[]) => T): Promise<T> {
    const safe = () => patterns.filter((p) => !fromCode(p));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ps = texts.some((t) => t.length > MAX_PATTERN_TEXT) ? safe() : this.usable(patterns);
      if (!ps.some(fromCode)) return local(ps);
      const r = await this.call(job(ps), this.limits.stepMs);
      if (this.used > this.limits.totalMs && !this.allDead) {
        this.allDead = true;
        this.notes.push("card code regexes dropped for this job (they used too much time in all)");
      }
      if (r.ok) return r.value as T;
      if (r.kind !== "timeout") {
        console.warn(`[card-translate] pattern worker ${r.kind}: ${r.message}; card formats not checked for this text`);
        return local(safe());
      }
      this.blame(r);
    }
    this.allDead = true;
    return local(safe());
  }

  private blame(r: { culprit: string | null; elapsed: number }): void {
    this.spent += r.elapsed;
    if (r.culprit != null && !this.dead.has(r.culprit)) {
      this.dead.add(r.culprit);
      this.skipped.push(r.culprit);
      this.notes.push(`card code regex skipped (too slow to run safely): /${r.culprit.slice(0, 80)}/`);
      console.warn(`[card-translate] card regex /${r.culprit.slice(0, 200)}/ ran too long; skipped for this job`);
    } else if (!this.allDead) {
      this.allDead = true;
      this.notes.push("card code regexes dropped for this job (a check ran too long)");
    }
    if (this.spent > this.limits.budgetMs && !this.allDead) {
      this.allDead = true;
      this.notes.push("card code regexes dropped for this job (too much time lost to slow ones)");
    }
  }

  /** One step in the worker; steps run one at a time, so a step's clock is never another step's wait. */
  private call(body: PatternJobBody, limitMs: number): Promise<CallResult> {
    const run = () => this.runCall(body, limitMs);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async runCall(body: PatternJobBody, limitMs: number): Promise<CallResult> {
    const w = await this.start();
    if (!w) return { ok: false, kind: "unavailable", message: "worker did not start" };
    const clock = this.clock;
    const ints = new Int32Array(clock, 0, 2), since = new Float64Array(clock, 8, 1);
    return new Promise<CallResult>((resolve) => {
      const id = this.nextId++;
      const started = Date.now();
      const finish = (r: CallResult) => {
        this.used += Date.now() - started;
        clearInterval(timer);
        w.off("message", onMessage);
        w.off("exit", onExit);
        resolve(r);
      };
      const onMessage = (m: PatternOutcome) => {
        if (m?.id !== id) return;
        finish(m.ok ? { ok: true, value: m.value } : { ok: false, kind: "error", message: m.error });
      };
      const onExit = () => finish({ ok: false, kind: "unavailable", message: "worker exited" });
      const timer = setInterval(() => {
        const now = Date.now();
        const running = Atomics.load(ints, CLOCK_RUNNING) === 1;
        if (!(running && now - since[0]! > this.limits.patternMs) && now - started <= limitMs) return;
        const culprit = running ? String.fromCharCode(...new Uint16Array(clock, 16, Atomics.load(ints, CLOCK_KEY_LENGTH))) : null;
        this.kill();
        finish({ ok: false, kind: "timeout", culprit, elapsed: now - started });
      }, Math.max(10, Math.min(100, Math.floor(this.limits.patternMs / 5))));
      w.on("message", onMessage);
      w.on("exit", onExit);
      w.postMessage({ ...body, id });
    });
  }

  private start(): Promise<Worker | null> {
    if (this.broken) return Promise.resolve(null);
    if (this.worker && this.ready) return this.ready;
    // A fresh clock: a stopped worker leaves its "running" flag set.
    this.clock = new SharedArrayBuffer(CLOCK_BYTES);
    let w: Worker;
    try {
      w = spawn({ buffer: this.clock });
    } catch (err) {
      console.error("[card-translate] pattern worker could not start:", err instanceof Error ? err.message : err);
      this.broken = true;
      return Promise.resolve(null);
    }
    w.unref();
    w.on("error", (err) => console.error("[card-translate] pattern worker error:", err instanceof Error ? err.message : err));
    w.on("exit", () => { if (this.worker === w) { this.worker = null; this.ready = null; } });
    this.worker = w;
    const ready = new Promise<Worker | null>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        w.off("message", onReady);
        w.off("exit", onExit);
        if (!ok) {
          console.error("[card-translate] pattern worker did not start; card formats will not be checked");
          this.broken = true;
          if (this.worker === w) this.kill();
        }
        resolve(ok ? w : null);
      };
      const onReady = (m: { ready?: boolean }) => { if (m?.ready) done(true); };
      const onExit = () => done(false);
      const timer = setTimeout(() => done(false), this.limits.startMs);
      w.on("message", onReady);
      w.on("exit", onExit);
    });
    this.ready = ready;
    return ready;
  }

  private kill(): void {
    const w = this.worker;
    // Forget it now: its exit event comes later, and the next step must not be handed the dying worker.
    this.worker = null;
    this.ready = null;
    if (w) void w.terminate();
  }
}
