import { randomUUID } from "node:crypto";
import type { SessionSummaryPayload } from "@yumina/shared";

export type SummaryJob = NonNullable<SessionSummaryPayload["job"]>;
export interface SummaryRunControl {
  id: string;
  signal: AbortSignal;
  progress: (completed: number, total: number, phase: "episodes" | "merge") => Promise<void>;
}
export interface SummaryJobStore {
  get(key: string): Promise<string | null>;
  compareAndSet(key: string, previous: string | null, next: string, ttlSeconds: number): Promise<boolean>;
}
// A crashed worker's database claim must expire before a retry is admitted.
export const SUMMARY_CLAIM_TTL_MS = 15 * 60_000;
const ACTIVE_TTL_MS = SUMMARY_CLAIM_TTL_MS + 30_000;
const JOB_TTL_SECONDS = 86_400;
const JOB_DEADLINE_MS = 10 * 60_000;
export const isActiveSummaryJob = (job: SummaryJob | null | undefined) =>
  job?.status === "queued" || job?.status === "running";

/** Shared-store CAS admits only one runner per session across replicas. */
export class SummaryJobManager {
  constructor(private store: SummaryJobStore, private now = Date.now) {}

  async read(key: string): Promise<SummaryJob | null> {
    const raw = await this.store.get(key);
    if (!raw) return null;
    const job: SummaryJob = JSON.parse(raw);
    if (isActiveSummaryJob(job) && this.now() - job.updatedAt > ACTIVE_TTL_MS) {
      const failed: SummaryJob = { ...job, status: "failed", error: "Summary worker stopped responding. Retry to reuse completed chunks.", updatedAt: this.now() };
      if (await this.store.compareAndSet(key, raw, JSON.stringify(failed), JOB_TTL_SECONDS)) return failed;
      return this.read(key);
    }
    return job;
  }

  async start(key: string, run: (control: SummaryRunControl) => Promise<unknown>): Promise<SummaryJob> {
    for (let tries = 0; tries < 4; tries++) {
      await this.read(key);
      const raw = await this.store.get(key);
      const previous: SummaryJob | null = raw ? JSON.parse(raw) : null;
      if (isActiveSummaryJob(previous)) return previous!;
      const job: SummaryJob = { id: randomUUID(), status: "queued", phase: "episodes", completed: 0, total: 0, error: null, updatedAt: this.now() };
      if (!(await this.store.compareAndSet(key, raw, JSON.stringify(job), JOB_TTL_SECONDS))) continue;
      setTimeout(() => { void this.execute(key, job, run); }, 0);
      return job;
    }
    throw new Error("Summary status changed while starting. Please try again.");
  }

  private async execute(key: string, job: SummaryJob, run: (control: SummaryRunControl) => Promise<unknown>) {
    const controller = new AbortController();
    let stopWaiting!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      stopWaiting = () => controller.signal.removeEventListener("abort", onAbort);
    });
    // Attach immediately, even if the initial store update fails before run().
    void aborted.catch(() => {});
    let updates = Promise.resolve();
    const update = (patch: Partial<SummaryJob>) => {
      const current = updates.then(async () => {
        const raw = await this.store.get(key);
        const existing: SummaryJob | null = raw ? JSON.parse(raw) : null;
        if (existing?.id !== job.id || !isActiveSummaryJob(existing)) throw new Error("Summary job is no longer active.");
        const next = { ...existing, ...patch, updatedAt: this.now() };
        if (!(await this.store.compareAndSet(key, raw, JSON.stringify(next), JOB_TTL_SECONDS))) throw new Error("Summary job ownership changed.");
      });
      updates = current.catch(error => { controller.abort(error); });
      return current;
    };
    const heartbeat = setInterval(() => { void update({}).catch(() => {}); }, 10_000);
    const deadline = setTimeout(() => controller.abort(new Error("Summary job timed out. Retry to reuse completed chunks.")), JOB_DEADLINE_MS);
    heartbeat.unref();
    deadline.unref();
    try {
      await update({ status: "running" });
      await Promise.race([aborted, run({ id: job.id, signal: controller.signal, progress: async (completed, total, phase) => {
        controller.signal.throwIfAborted();
        await update({ completed, total, phase });
      } })]);
      controller.signal.throwIfAborted();
      await update({ status: "completed" });
    } catch (error) {
      await update({ status: "failed", error: error instanceof Error ? error.message : "Summary generation failed" }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      stopWaiting();
    }
  }
}
