/** Media lifetime follows the visible world, including detached Audio objects. */
export function installSandboxMedia() {
  let suspended = false;
  const media = new Set<WeakRef<HTMLMediaElement>>();
  const seen = new WeakSet<HTMLMediaElement>();
  const contexts = new Set<WeakRef<AudioContext>>();
  const hostSuspended = new WeakSet<AudioContext>();
  function track(el: HTMLMediaElement) {
    if (seen.has(el)) return;
    seen.add(el);
    media.add(new WeakRef(el));
    // Native autoplay can bypass the JS play() method.
    el.addEventListener("play", () => { if (suspended) el.pause(); });
  }
  const nativePlay = window.HTMLMediaElement.prototype.play;
  window.HTMLMediaElement.prototype.play = function () {
    track(this);
    if (suspended) return Promise.reject(new DOMException("World is inactive", "NotAllowedError"));
    return nativePlay.call(this);
  };
  window.Audio = new Proxy(window.Audio, {
    construct(Target, args) {
      const el = Reflect.construct(Target, args) as HTMLAudioElement;
      track(el);
      return el;
    },
  });
  document.addEventListener("play", event => {
    const el = event.target;
    if (el instanceof window.HTMLMediaElement) {
      track(el);
      if (suspended) el.pause();
    }
  }, true);

  function suspendContext(ctx: AudioContext) {
    if (ctx.state !== "running") return;
    hostSuspended.add(ctx);
    void ctx.suspend().then(() => {
      // Navigating back may race the native asynchronous suspend operation.
      if (!suspended && hostSuspended.delete(ctx)) void ctx.resume().catch(() => {});
    }).catch(() => {});
  }
  const win = window as unknown as Record<string, unknown>;
  for (const key of ["AudioContext", "webkitAudioContext"]) {
    const Ctor = win[key] as typeof AudioContext | undefined;
    if (!Ctor) continue;
    win[key] = new Proxy(Ctor, {
      construct(Target, args) {
        const ctx = Reflect.construct(Target, args) as AudioContext;
        contexts.add(new WeakRef(ctx));
        const resume = ctx.resume.bind(ctx);
        ctx.resume = () => suspended ? Promise.resolve() : resume();
        ctx.addEventListener("statechange", () => { if (suspended) suspendContext(ctx); });
        if (suspended) suspendContext(ctx);
        return ctx;
      },
    });
  }
  return {
    setSuspended(value: boolean) {
      suspended = value;
      if (value) {
        document.querySelectorAll<HTMLMediaElement>("video, audio").forEach(el => { track(el); el.pause(); });
        for (const ref of media) {
          const el = ref.deref();
          if (el) el.pause();
          else media.delete(ref);
        }
      }
      for (const ref of contexts) {
        const ctx = ref.deref();
        if (!ctx || ctx.state === "closed") { contexts.delete(ref); continue; }
        if (value) suspendContext(ctx);
        else if (hostSuspended.delete(ctx)) void ctx.resume().catch(() => {});
      }
    },
    rescueAutoplay() {
      if (suspended) return;
      document.querySelectorAll<HTMLMediaElement>("video[autoplay], audio[autoplay]")
        .forEach(el => { if (el.paused) void el.play()?.catch(() => {}); });
    },
  };
}
