interface MotionState { position: number; velocity: number }

export function advanceHeaderMotion(state: MotionState, target: number, seconds: number): MotionState {
  // Exact critically damped integration: retarget without discarding velocity.
  const frequency = 30;
  const elapsed = Math.max(0, seconds);
  const error = state.position - target;
  const carry = state.velocity + frequency * error;
  const decay = Math.exp(-frequency * elapsed);
  const position = target + (error + carry * elapsed) * decay;
  const velocity = (state.velocity - frequency * carry * elapsed) * decay;
  if (position < 0 || position > 1) return { position: Math.min(1, Math.max(0, position)), velocity: 0 };
  return { position, velocity };
}

/** Keep the viewport sampling edge still; only the controls translate.
 * A shrinking clip removes the surface with them, and releases it at rest. */
export function createHeaderMotion(view: Window, header: HTMLElement) {
  let state: MotionState = { position: 0, velocity: 0 };
  let target = 0;
  let frame: number | null = null;
  let lastTime: number | null = null;
  const reduced = view.matchMedia?.("(prefers-reduced-motion: reduce)");
  const paint = () => {
    header.style.setProperty("--topbar-motion-progress", String(state.position));
    header.toggleAttribute("data-motion-hidden", state.position === 1);
    header.toggleAttribute("data-motion-active", state.position !== target || Math.abs(state.velocity) >= 0.01);
  };
  const tick = (time: number) => {
    frame = null;
    const seconds = lastTime === null ? 1 / 60 : Math.min(0.1, (time - lastTime) / 1000);
    lastTime = time;
    state = advanceHeaderMotion(state, target, seconds);
    if (Math.abs(state.position - target) < 0.001 && Math.abs(state.velocity) < 0.01) {
      state = { position: target, velocity: 0 };
      lastTime = null;
    } else frame = view.requestAnimationFrame(tick);
    paint();
  };
  const snap = (hidden: boolean) => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    lastTime = null;
    target = hidden ? 1 : 0;
    state = { position: target, velocity: 0 };
    if (header.hasAttribute("data-scroll-motion")) paint();
  };
  return {
    setHidden(hidden: boolean) {
      header.style.setProperty("--topbar-motion-distance", `${header.offsetHeight + 1}px`);
      header.setAttribute("data-scroll-motion", "");
      target = hidden ? 1 : 0;
      // Unhide before starting the return. The clip still paints the same
      // first 8px, so Safari cannot seed its retained tint from the tail.
      if (!hidden) header.removeAttribute("data-motion-hidden");
      if (reduced?.matches) { snap(hidden); return; }
      paint();
      if (frame === null) frame = view.requestAnimationFrame(tick);
    },
    reveal: () => snap(false),
    dispose() {
      snap(false);
      header.removeAttribute("data-scroll-motion");
      header.removeAttribute("data-motion-hidden");
      header.removeAttribute("data-motion-active");
      header.style.removeProperty("--topbar-motion-progress");
      header.style.removeProperty("--topbar-motion-distance");
    },
  };
}
