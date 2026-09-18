import type { Timer, TimerState } from "./types.js";
import type { GameEvent } from "../events/types.js";

/**
 * TimerRuntime — manages countdown and interval timers.
 *
 * Call `tick(dt)` from a client-side game loop (requestAnimationFrame).
 * Returns GameEvents for timers that fired or ticked.
 *
 * Framework-agnostic — no DOM, no browser APIs.
 */
export class TimerRuntime {
  private timers: Map<string, Timer> = new Map();

  constructor(initialTimers?: Timer[]) {
    if (initialTimers) {
      for (const t of initialTimers) {
        this.timers.set(t.id, { ...t });
      }
    }
  }

  /** Get snapshot of all timers */
  getState(): TimerState {
    return { timers: [...this.timers.values()].map((t) => ({ ...t })) };
  }

  /** Get a single timer by ID */
  getTimer(id: string): Timer | undefined {
    const t = this.timers.get(id);
    return t ? { ...t } : undefined;
  }

  /**
   * Create and start a new timer.
   * If a timer with this ID already exists, it's reset.
   */
  start(id: string, name: string, duration: number, repeat: boolean = false): void {
    this.timers.set(id, {
      id,
      name,
      duration,
      remaining: duration,
      repeat,
      active: true,
      paused: false,
    });
  }

  /** Pause a running timer */
  pause(id: string): void {
    const t = this.timers.get(id);
    if (t && t.active) {
      t.paused = true;
    }
  }

  /** Resume a paused timer */
  resume(id: string): void {
    const t = this.timers.get(id);
    if (t && t.paused) {
      t.paused = false;
    }
  }

  /** Cancel and remove a timer */
  cancel(id: string): void {
    this.timers.delete(id);
  }

  /** Cancel all timers */
  cancelAll(): void {
    this.timers.clear();
  }

  /**
   * Advance all active timers by dt seconds.
   * Returns events for timers that fired.
   *
   * Call this from requestAnimationFrame:
   *   const dt = (now - lastTime) / 1000;
   *   const events = timerRuntime.tick(dt);
   *
   * @param dt Delta time in seconds
   */
  tick(dt: number): GameEvent[] {
    const events: GameEvent[] = [];

    for (const timer of this.timers.values()) {
      if (!timer.active || timer.paused) continue;

      timer.remaining -= dt;

      if (timer.remaining <= 0) {
        // Timer fired
        events.push({
          type: "timer:fired",
          timerId: timer.id,
          timerName: timer.name,
          duration: timer.duration,
          repeat: timer.repeat,
        });

        if (timer.repeat) {
          // Reset for next interval (carry over overshoot for accuracy)
          timer.remaining = timer.duration + timer.remaining;
        } else {
          // One-shot — deactivate
          timer.active = false;
          timer.remaining = 0;
        }
      }
    }

    // Clean up inactive non-repeat timers
    for (const [id, timer] of this.timers) {
      if (!timer.active && !timer.repeat) {
        this.timers.delete(id);
      }
    }

    return events;
  }
}
