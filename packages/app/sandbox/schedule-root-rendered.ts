type RenderScheduler = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout" | "clearTimeout">;

/** Call only after the hydrated root (or its error panel) has committed. */
export function scheduleRootRendered(clock: RenderScheduler, notify: () => void): () => void {
  let active = true;
  let frame: number | undefined;
  let timer: number | undefined;
  const cancel = () => {
    active = false;
    if (frame !== undefined) clock.cancelAnimationFrame(frame);
    if (timer !== undefined) clock.clearTimeout(timer);
  };
  const finish = () => {
    if (!active) return;
    cancel();
    notify();
  };
  timer = clock.setTimeout(finish, 1000);
  frame = clock.requestAnimationFrame(() => {
    if (!active) return;
    frame = clock.requestAnimationFrame(finish);
  });
  return cancel;
}
