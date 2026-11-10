import { imageUploadError } from "./image-upload-policy.js";
import { createCoverUploadProcessor } from "./cover-upload.js";
import { getObjectBufferLimited, headObject, putObject } from "./s3.js";

type Publication = Awaited<ReturnType<ReturnType<typeof createCoverUploadProcessor>["publish"]>>;
type Job = { touched: number; pending: boolean; value?: Publication; error?: unknown; completion?: Promise<void> };

/** Polling keeps requests short; only one source is buffered or decoded at a time.
 * Completed storage keys make retries recoverable after a process restart. */
export function createCoverUploadJobs(publish: (source: string, prefix: string) => Promise<Publication>,
  now = Date.now, available = () => process.availableMemory()) {
  const jobs = new Map<string, Job>();
  let running = false;
  return {
    poll(source: string, prefix: string): Publication | null {
      for (const [id, job] of jobs) if (!job.pending && now() - job.touched > 600_000) jobs.delete(id);
      const id = JSON.stringify([source, prefix]);
      const existing = jobs.get(id);
      if (existing) {
        existing.touched = now();
        if (existing.error) { jobs.delete(id); throw existing.error; }
        return existing.value ?? null;
      }
      // Bound reads first. Motion decoding checks its larger budget separately,
      // so a small still does not require a video's memory allowance.
      if (running || available() < 128 * 1024 * 1024) return imageUploadError("Image processing is busy. Please try again shortly.", 503);
      if (jobs.size >= 64) jobs.delete(jobs.keys().next().value!);
      const job: Job = { touched: now(), pending: true };
      jobs.set(id, job);
      running = true;
      job.completion = Promise.resolve().then(() => publish(source, prefix)).then(value => { job.value = value; }, error => { job.error = error; })
        .finally(() => { job.pending = false; job.touched = now(); running = false; });
      return null;
    },
    /** Existing editor tabs expect a completed 200 response, not a job status. */
    async complete(source: string, prefix: string): Promise<Publication> {
      const result = this.poll(source, prefix);
      if (result) return result;
      const id = JSON.stringify([source, prefix]);
      const job = jobs.get(id)!;
      await job.completion;
      if (job.error) {
        if (jobs.get(id) === job) jobs.delete(id);
        throw job.error;
      }
      return job.value!;
    },
  };
}

const processor = createCoverUploadProcessor({ head: key => headObject(key, { signal: AbortSignal.timeout(10_000) }), read: getObjectBufferLimited,
  write: (key, bytes, type) => putObject(key, bytes, type, { signal: AbortSignal.timeout(30_000) }) });
export const coverUploadJobs = createCoverUploadJobs(processor.publish);
