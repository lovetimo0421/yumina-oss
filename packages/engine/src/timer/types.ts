/**
 * Timer System — countdown and interval timers that emit events.
 *
 * Timers are created at runtime (by reactions or custom components)
 * and tick down based on elapsed time. When a timer reaches zero,
 * it emits a `timer:fired` event. Interval timers reset and repeat.
 *
 * The TimerRuntime is called from a client-side game loop
 * (requestAnimationFrame) with delta-time in seconds.
 */

/** A timer definition */
export interface Timer {
  id: string;
  name: string;
  /** Total duration in seconds */
  duration: number;
  /** Remaining time in seconds */
  remaining: number;
  /** Whether this timer repeats after firing */
  repeat: boolean;
  /** Whether this timer is currently running */
  active: boolean;
  /** Whether this timer has been paused (can be resumed) */
  paused: boolean;
}

/** Snapshot of all timer state */
export interface TimerState {
  timers: Timer[];
}
