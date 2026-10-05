const apiBase = import.meta.env?.VITE_API_URL || "";

export async function fetchUploadConcurrency(signal?: AbortSignal): Promise<number> {
  try {
    const response = await fetch(`${apiBase}/api/user-assets/upload-policy`, { credentials: "include", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (!response.ok) return 2;
    const payload = await response.json() as { data?: { concurrency?: number } };
    return [2,4,6].includes(payload.data?.concurrency ?? 0) ? payload.data!.concurrency! : 2;
  } catch {
    signal?.throwIfAborted();
    return 2;
  }
}

/** Starts only a bounded number of operations, including across async failures. */
export async function runUploadBatch<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>, stopped: () => boolean = () => false) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Math.min(6, Math.floor(concurrency)))) }, async () => {
    while (!stopped() && next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  }));
}
