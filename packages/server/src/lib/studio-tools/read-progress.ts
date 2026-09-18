import type { ToolCall } from "../llm/types.js";
import { parseToolArgs } from "./parse-tool-args.js";

/** ── Read-Progress Tracker ──────────────────────────────────────────────
 *
 *  Detects the read spiral the agent loop must break out of: the model asking
 *  for the SAME thing over and over instead of acting on what it already has.
 *
 *  The unit of repetition is the *request*, not the entity id. This distinction
 *  is the whole point of this module. The original guard counted "touched this
 *  id again" and terminated the run on the 3rd consecutive turn — which was
 *  correct back when `read_entities` could only return a whole file, and dead
 *  wrong once `offset_lines`/`limit_lines` landed. Reading lines 1-200, then
 *  200-500, then 500-777 is three touches of one id and three *different*
 *  answers: textbook progress, killed as a loop. Prod bore this out — 89% of
 *  spiral terminations were distinct slices or distinct grep queries, against
 *  ~2% genuine repeats.
 *
 *  So: a touch is (id, signature), where the signature captures what actually
 *  determines the response — the slice for `read_entities`, the query+scope for
 *  `grep_world`. A signature never seen before is progress, however many times
 *  its id has been touched. A signature seen before is a repeat, and three of
 *  those still ends the run, exactly as strictly as before. */

/** One read request, reduced to the entity it targets and what it asked for. */
export type ReadTouch = { id: string; signature: string };

type Entry = {
  /** Every distinct request already issued for this id (since the last write). */
  seen: Set<string>;
  /** Consecutive turns in which this id was asked something it had been asked before. */
  repeats: number;
  /** Turns that touched this id at all — distinct slices included. Drives the wander nudge. */
  turns: number;
};

export type ReadProgressState = Map<string, Entry>;

export type ReadProgressVerdict =
  /** Every request this turn was new. Nothing to say. */
  | { kind: "progress" }
  /** Second identical request for `id` — warn, but let the model correct itself. */
  | { kind: "repeat"; id: string }
  /** Third identical request for `id` — no new information is coming; end the run. */
  | { kind: "stop"; id: string }
  /** Many distinct slices of `id` and still no edit. Not a loop, but worth a shove. */
  | { kind: "wandering"; id: string; turns: number };

/** Identical request seen this many times in a row → terminate. 3 total (first
 *  issue + 2 repeats), matching the strictness of the id-based guard it replaces. */
const REPEAT_LIMIT = 2;
/** Distinct-slice touches of one id before we nudge (once) toward acting on what
 *  it has. Never terminates — pagination is legitimate, just not infinitely. */
const WANDER_TURN_LIMIT = 8;

export function createReadProgressState(): ReadProgressState {
  return new Map();
}

/** Reduce read-type tool calls to (id, signature) pairs. Non-read tools and
 *  malformed arguments are skipped — the executor surfaces those errors. */
export function extractReadTouches(calls: ToolCall[]): ReadTouch[] {
  const out: ReadTouch[] = [];
  for (const tc of calls) {
    const name = tc.function.name;
    if (name !== "read_entities" && name !== "grep_world") continue;
    let args: Record<string, unknown>;
    try {
      args = parseToolArgs(tc.function.arguments) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (name === "read_entities") {
      // The slice IS the request. Two reads of one file at different offsets are
      // two different questions; only the same window twice is a re-read.
      const signature = `read:${JSON.stringify([args.offset_lines ?? null, args.limit_lines ?? null])}`;
      if (Array.isArray(args.ids)) {
        for (const id of args.ids) if (typeof id === "string") out.push({ id, signature });
      }
      // Models sometimes send the singular `id` here. The executor returns nothing for
      // it, so the call is pure loop fuel — still worth tracking so a model stuck on it
      // gets stopped rather than burning to the iteration cap.
      if (typeof args.id === "string") out.push({ id: args.id, signature });
      continue;
    }

    // grep_world: the query is the request. Different queries against one file
    // are different questions and were never re-reads to begin with.
    if (typeof args.id !== "string") continue;
    out.push({
      id: args.id,
      signature: `grep:${JSON.stringify([
        typeof args.query === "string" ? args.query : null,
        args.scope ?? null,
        args.context_lines ?? null,
      ])}`,
    });
  }
  return out;
}

/** Fold one turn's touches into `state` (mutated in place) and report what the
 *  loop should do about it. */
export function recordReadTouches(state: ReadProgressState, touches: ReadTouch[]): ReadProgressVerdict {
  const byId = new Map<string, string[]>();
  for (const t of touches) {
    const sigs = byId.get(t.id);
    if (sigs) sigs.push(t.signature);
    else byId.set(t.id, [t.signature]);
  }

  for (const [id, signatures] of byId) {
    const entry = state.get(id) ?? { seen: new Set<string>(), repeats: 0, turns: 0 };
    // Check every signature against what came BEFORE this turn, then record them.
    // Two parallel calls with one signature are one request issued once, not a repeat.
    const repeated = signatures.some((s) => entry.seen.has(s));
    for (const s of signatures) entry.seen.add(s);
    entry.repeats = repeated ? entry.repeats + 1 : 0;
    entry.turns += 1;
    state.set(id, entry);
  }

  // Judge only what this turn actually asked for. An id left alone is not a
  // reason to keep scolding the model about it turn after turn — a standing
  // nudge is noise it learns to ignore.
  const touched = [...byId.keys()].map((id) => [id, state.get(id)!] as const);
  // Worst signal wins, and a genuine repeat always outranks mere breadth.
  for (const [id, entry] of touched) if (entry.repeats >= REPEAT_LIMIT) return { kind: "stop", id };
  for (const [id, entry] of touched) if (entry.repeats > 0) return { kind: "repeat", id };
  // Fire on the crossing turn only, so the shove lands once.
  for (const [id, entry] of touched) if (entry.turns === WANDER_TURN_LIMIT) return { kind: "wandering", id, turns: entry.turns };
  return { kind: "progress" };
}

/** A write changed the world, so everything read before it may legitimately be
 *  re-read. Drops all history. */
export function clearReadProgress(state: ReadProgressState): void {
  state.clear();
}

/** Terminal message shown to the creator when a run is cut for looping. Kept on
 *  the "Stopped: " prefix that `studio-conversations` uses to recognize
 *  server-authored notices on rows written before `lane` existed. */
export function readSpiralStopMessage(id: string): string {
  return `Stopped: "${id}" was requested three times with identical arguments — the same call can only return the same answer. If you're chasing a syntax error or a blank render, call validate_world — it returns the exact file + line + a code window around the break. Otherwise use grep_world with a different query, or read_entities with an offset_lines range you haven't read yet, then edit_custom_ui to modify.`;
}

/** Injected as a user turn on the second identical request — a course
 *  correction while the model can still recover. */
export function readRepeatNudge(id: string): string {
  return `[System: You just re-issued an identical request for "${id}" — it returns exactly what you already have. Do not repeat it. If you're chasing a syntax error or a blank/broken render, call validate_world: it returns the exact file + line + a code window around the break, so you can fix it without re-reading. To see a part you haven't read, call read_entities({ ids: ["${id}"], offset_lines, limit_lines }) with a NEW range, or grep_world({ query: "...", id: "${id}" }) with a NEW query. If you already have what you need, proceed to edit_custom_ui.]`;
}

/** Injected once when a file has been paged through many times without an edit.
 *  Distinct slices are progress, so this only prods — it never ends the run. */
export function readWanderNudge(id: string, turns: number): string {
  return `[System: You've pulled ${turns} separate slices of "${id}" without editing it. That's enough context — make the change with edit_custom_ui now, or call validate_world if you're still hunting a syntax error. Only read again if you need a range you genuinely haven't seen.]`;
}
