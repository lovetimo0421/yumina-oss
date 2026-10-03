export type SandboxBootStage = "attached" | "loaded" | "ready" | "install_requested" | "rendered";

/** Passive timing only: never changes boot deadlines, retries, or game state.
 * Durations use a monotonic clock and split foreground/background time. */
export class SandboxBootTiming {
  private readonly startedAt: number;
  private changedAt: number;
  private foregroundMs = 0;
  private backgroundMs = 0;
  private visibilityChanges = 0;
  private stages: Partial<Record<SandboxBootStage, number>> = {};

  constructor(private now: () => number, private visible: boolean) {
    this.startedAt = this.changedAt = now();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.accountUntil(this.now());
    this.visible = visible;
    this.visibilityChanges++;
  }

  mark(stage: SandboxBootStage): void {
    this.stages[stage] ??= Math.max(0, this.now() - this.startedAt);
  }

  snapshot(): Record<string, string | number | boolean> {
    const now = this.now();
    this.accountUntil(now);
    return {
      timing_version: 1,
      elapsed_ms: Math.round(Math.max(0, now - this.startedAt)),
      foreground_ms: Math.round(this.foregroundMs),
      background_ms: Math.round(this.backgroundMs),
      page_visible: this.visible,
      visibility_changes: this.visibilityChanges,
      ...Object.fromEntries(Object.entries(this.stages).map(([stage, ms]) => [`${stage}_ms`, Math.round(ms)])),
    };
  }

  private accountUntil(now: number): void {
    const elapsed = Math.max(0, now - this.changedAt);
    if (this.visible) this.foregroundMs += elapsed;
    else this.backgroundMs += elapsed;
    this.changedAt = now;
  }
}
