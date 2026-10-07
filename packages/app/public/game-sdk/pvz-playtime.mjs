import { createGameIdentity } from "./identity.mjs";

const HEARTBEAT_MS = 15_000;
// The native engine uses 100 simulation ticks per second. Never credit accelerated
// ticks beyond foreground wall time, or gaps beyond the server's interval bound.
const TICK_MS = 10;
const MAX_INTERVAL_MS = 90_000;

export function readPvzSnapshot(module) {
  try {
    const pointer = module?._pvz_dave_snapshot?.();
    return pointer && typeof module.UTF8ToString === "function" ? JSON.parse(module.UTF8ToString(pointer)) : null;
  } catch { return null; }
}

function eligible(snapshot) {
  return snapshot?.game === "pvz" && snapshot.mode === "adventure" && snapshot.phase === "playing"
    && !snapshot.defeated && !snapshot.paused
    && Number.isSafeInteger(snapshot.elapsedTicks) && snapshot.elapsedTicks >= 0
    && Number.isSafeInteger(snapshot.levelEpoch) && snapshot.levelEpoch >= 0;
}

/** An in-memory, cumulative reporter. Reloads and identity changes start fresh sessions. */
export function createPvzPlaytimeCollector(options) {
  const now = options.now || (() => performance.now());
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());
  let session = null, previous = null, active = false, stopped = false;
  let running = false, pending = null, retry = false, retryPause = false, lastAttempt = -Infinity;

  function baseline() {
    const value = options.snapshot();
    return options.visible() && eligible(value) ? { ...value, at: now() } : null;
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending) {
        const requested = pending;
        pending = null;
        lastAttempt = now();
        let attemptedEvent = null;
        let attemptedBody = null;
        try {
          // A terminal flush must reach fetch(keepalive) before page teardown.
          // The server binds an existing session ID to its authenticated subject,
          // so a cookie switch cannot give the new account this session's time.
          const identity = (requested === "pause" || requested === "stop") && session
            ? session.identity : await options.identity();
          if (!identity?.subject) {
            session = null; previous = null; retryPause = false; retry = true;
            continue;
          }
          if (!session || session.identity.subject !== identity.subject) {
            session = { id: randomUUID(), identity, sequence: 0, activeMs: 0, remoteActive: false, resumeRetry: null };
            retryPause = false;
            previous = baseline();
          } else session.identity = identity;
          // A failed terminal flush still owns earned cumulative time. Deliver
          // it before resume, which intentionally resets the server's baseline.
          const event = retryPause ? "pause" : stopped ? "stop" : !active ? "pause"
            : requested === "resume" || !session.remoteActive ? "resume" : "tick";
          // A resume may have reached the server even when its response was lost.
          // Replay its original sequence/watermark before sending accumulated
          // progress; a new resume would consume that progress without credit.
          const resumeRetry = session.resumeRetry;
          const body = { ...(resumeRetry ?? { sessionId: session.id, sequence: ++session.sequence, event, activeMs: Math.floor(session.activeMs) }),
            ...(identity.guestToken ? { guestToken: identity.guestToken } : {}) };
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          timeout.unref?.();
          try {
            attemptedEvent = body.event;
            attemptedBody = body;
            const response = await fetcher("/api/game/pvz/playtime", { method: "POST", credentials: "include",
              headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true, signal: controller.signal });
            if (!response.ok) throw new Error("Playtime unavailable");
            const result = await response.json();
            session.remoteActive = result.active === true;
            session.resumeRetry = null;
            retry = false;
            if (resumeRetry) {
              if (stopped || !active) pending = stopped ? "stop" : "pause";
              else if (session.remoteActive && session.activeMs > body.activeMs) pending = "tick";
            }
            if (body.event === "pause") {
              retryPause = false;
              if (active || stopped) pending = stopped ? "stop" : "resume";
            }
          } finally { clearTimeout(timeout); }
        } catch {
          retry = true;
          if (attemptedEvent === "pause") retryPause = true;
          if (attemptedEvent === "resume" && session) session.resumeRetry = attemptedBody;
        }
      }
    } finally { running = false; }
  }

  function queue(event) {
    pending = event;
    void drain();
  }

  function sample() {
    if (stopped) return;
    const current = baseline();
    const wasActive = active;
    if (!current) {
      active = false;
    } else if (previous && previous.levelEpoch === current.levelEpoch && previous.runId === current.runId) {
      const elapsed = current.at - previous.at;
      const progress = current.elapsedTicks - previous.elapsedTicks;
      active = elapsed > 0 && progress > 0;
      if (active && wasActive && session) session.activeMs += Math.max(0, Math.min(elapsed, progress * TICK_MS, MAX_INTERVAL_MS));
    } else {
      // Establish a clock baseline; no credit for menus, level resets or hidden time.
      active = true;
    }
    previous = current;
    if (active !== wasActive) {
      // While identity is unavailable, don't retry its lookup every sample.
      if (session || now() - lastAttempt >= HEARTBEAT_MS) queue(active ? "resume" : "pause");
    } else if ((active || retry) && now() - lastAttempt >= HEARTBEAT_MS) {
      queue(active ? "tick" : "pause");
    }
  }

  function flush(event = "pause") {
    active = false; previous = null;
    if (event === "stop") stopped = true;
    if (session || running) queue(event === "stop" ? "stop" : "pause");
  }

  return { sample, flush };
}

async function accountIdentity(fetcher, guest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetcher("/api/game/me", { credentials: "include", cache: "no-store", signal: controller.signal });
    if (response.ok) {
      const account = await response.json();
      return typeof account.id === "string" && account.id ? { subject: `account:${account.id}` } : null;
    }
    if (response.status !== 401) return null;
    const identity = await guest.get();
    return identity ? { subject: identity.guestId, guestToken: identity.guestToken } : null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

/** Called only by the injected module; no engine hooks, storage writes or gameplay changes. */
export function startPvzPlaytime(env = globalThis) {
  if (env.PVZ_PREVIEW?.isolated === true || env.PVZ_PREVIEW?.offline === true
    || !/^https?:$/.test(env.location?.protocol || "")
    || !/^\/pvz\/(?:index\.html|pvz-portable\.html)?$/.test(env.location?.pathname || "")) return null;
  if (env.__yuminaPvzPlaytime) return env.__yuminaPvzPlaytime;
  const fetcher = env.fetch.bind(env);
  const guest = createGameIdentity({ fetch: fetcher });
  const collector = createPvzPlaytimeCollector({
    fetch: fetcher, now: () => env.performance.now(), randomUUID: () => env.crypto.randomUUID(),
    snapshot: () => readPvzSnapshot(env.Module),
    visible: () => !env.document.hidden && !env.PVZ_PREVIEW?.isolated && !env.PVZ_PREVIEW?.offline,
    identity: () => accountIdentity(fetcher, guest),
  });
  const timer = env.setInterval(() => collector.sample(), 1000);
  const visibility = () => env.document.hidden ? collector.flush("pause") : collector.sample();
  const pagehide = event => collector.flush(event.persisted ? "pause" : "stop");
  env.document.addEventListener("visibilitychange", visibility);
  env.addEventListener("pagehide", pagehide);
  env.addEventListener("pageshow", visibility);
  const handle = { stop() {
    collector.flush("stop"); env.clearInterval(timer);
    env.document.removeEventListener("visibilitychange", visibility);
    env.removeEventListener("pagehide", pagehide); env.removeEventListener("pageshow", visibility);
    delete env.__yuminaPvzPlaytime;
  } };
  env.__yuminaPvzPlaytime = handle;
  collector.sample();
  return handle;
}

if (typeof window !== "undefined") startPvzPlaytime(window);
