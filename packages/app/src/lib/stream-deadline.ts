/** Bound a stalled fetch/read without retrying a request that may have reached the server. */
export function withStreamDeadline<T>(work: Promise<T>, signal: AbortSignal, onTimeout: () => void, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", aborted); callback();
    };
    const aborted = () => finish(() => reject(new DOMException("Cancelled", "AbortError")));
    const timer = setTimeout(() => finish(() => {
      reject(new Error("The connection stopped responding. Recovering the reply; you can stop waiting and try again."));
      onTimeout();
    }), ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
