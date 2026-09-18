/**
 * Race a promise against a timeout. If the promise settles first, its result
 * (or rejection) is used. If `ms` elapses first, resolve with `onTimeout()` and
 * ignore the promise's eventual settlement. Use for bounding a slow external
 * call (e.g. a Stripe round-trip) on a latency-sensitive path.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
