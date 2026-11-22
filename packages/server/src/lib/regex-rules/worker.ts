/**
 * Applies a player's regex rules to the history sent to the AI, off the main thread. A rule written by a player
 * can take exponential time on some text; here that only stalls this worker, which runner.ts replaces.
 */
import { parentPort } from "node:worker_threads";
import { applyRegexRules, type RegexRule } from "@yumina/shared";

export interface RegexJob {
  id: number;
  rules: RegexRule[];
  /** Oldest first. Depth is counted from the newest (0). */
  rows: Array<{ role: string; content: string }>;
}
export interface RegexOutcome {
  id: number;
  contents: string[];
}

parentPort?.on("message", (job: RegexJob) => {
  const last = job.rows.length - 1;
  const contents = job.rows.map((row, i) =>
    applyRegexRules(row.content, job.rules, { role: row.role, where: "prompt", depth: last - i }));
  parentPort!.postMessage({ id: job.id, contents } satisfies RegexOutcome);
});
