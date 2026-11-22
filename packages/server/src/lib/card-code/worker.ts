/**
 * Compiles one card's code off the main thread (see stamp.ts). The biggest
 * cards take up to a second in Sucrase; on the request thread that second
 * would stall every other request on the instance.
 */
import { parentPort } from "node:worker_threads";
import { compileRootComponent, type CompiledRoot } from "@yumina/shared/card-code";

/** The server's own test for an embedded file (asset-validation.ts), without
 *  the /g flag that makes .test() stateful. A card carrying one is left to the
 *  live compile, as the editor does: a stamp would double that bloat. */
const EMBEDDED_FILE = /data:(?:image|audio|video|font)\/[^;,]+;base64,[A-Za-z0-9+/=]{200,}/;

export interface CompileJob {
  id: number;
  entryFile: string;
  files: Record<string, string>;
}

export interface CompileOutcome {
  id: number;
  /** null: did not compile, or was skipped. */
  compiled: CompiledRoot | null;
  /** The files exactly as compiled, for the write's "still the same code" guard. */
  filesJson: string;
  skipped?: "embedded-file";
  ms: number;
}

parentPort?.on("message", (job: CompileJob) => {
  const started = performance.now();
  const filesJson = JSON.stringify(job.files);
  let compiled: CompiledRoot | null = null;
  let skipped: CompileOutcome["skipped"];
  if (EMBEDDED_FILE.test(filesJson)) {
    skipped = "embedded-file";
  } else {
    try {
      compiled = compileRootComponent(job.entryFile, job.files);
    } catch {
      compiled = null;
    }
  }
  const outcome: CompileOutcome = { id: job.id, compiled, filesJson, skipped, ms: Math.round(performance.now() - started) };
  parentPort!.postMessage(outcome);
});
