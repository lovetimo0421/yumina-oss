/** Catch up on startup, then run at wall-clock boundaries instead of boot-relative times. */
export function startClockAlignedInterval(
  intervalMs: number,
  task: (now: Date) => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false;
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    if (stopped) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      do {
        pending = false;
        try { await task(new Date()); }
        catch (error) { onError(error); }
        // Coalesce busy ticks into one catch-up with a fresh timestamp.
      } while (pending && !stopped);
    } finally { running = false; }
  };
  const schedule = () => {
    if (stopped) return;
    // A small offset ensures the DB and JS deadline tests see the new boundary.
    timer = setTimeout(() => { schedule(); void tick(); }, intervalMs - (Date.now() % intervalMs) + 50);
    timer.unref();
  };
  schedule();
  void tick();
  return () => { stopped = true; pending = false; clearTimeout(timer); };
}
