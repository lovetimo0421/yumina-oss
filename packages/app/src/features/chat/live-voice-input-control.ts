/** Owns the provider's input state separately from local microphone capture.
 * Only one command can be in flight; a newer request is sent after its predecessor
 * settles. Neither an old acknowledgment nor a mute acknowledgment ends speech. */
export class LiveVoiceInputControl {
  private requested = false;
  private acknowledged = false;
  private pending?: { id: string; muted: boolean; timer: ReturnType<typeof setTimeout> };
  private sequence = 0;
  private closed = false;
  private failed = false;

  constructor(private deps: {
    send(event: Record<string, unknown>): void;
    changed(): void;
    fail(message: string): void;
  }) {}

  get captureAllowed() { return !this.closed && !this.failed && !this.requested && !this.pending && !this.acknowledged; }
  get muted() { return !this.closed && !this.failed && this.requested && !this.pending && this.acknowledged; }

  request(muted: boolean) {
    if (this.closed || this.failed) return;
    this.requested = muted;
    this.pump();
  }

  private pump() {
    if (this.closed || this.failed) return;
    if (this.pending || this.requested === this.acknowledged) { this.deps.changed(); return; }
    const id = `live-input-${++this.sequence}`;
    const muted = this.requested;
    this.pending = { id, muted, timer: setTimeout(() => this.fail(), 8000) };
    // Close capture/hold output before sending, including synchronous transports.
    this.deps.changed();
    this.deps.send({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: id });
  }

  receive(event: Record<string, unknown>): boolean {
    if (this.closed || this.failed) return false;
    if (event.type === 'error') {
      const error = event.error as { client_event_id?: unknown } | undefined;
      if (!this.pending || error?.client_event_id !== this.pending.id) return false;
      this.fail(); return true;
    }
    if (event.type !== 'session.input_audio.muted' && event.type !== 'session.input_audio.unmuted') return false;
    const pending = this.pending;
    if (!pending || event.client_event_id !== pending.id || (event.type === 'session.input_audio.muted') !== pending.muted) return true;
    clearTimeout(pending.timer); this.pending = undefined;
    this.acknowledged = pending.muted;
    this.pump(); return true;
  }

  private fail() {
    if (this.closed || this.failed) return;
    this.failed = true;
    clearTimeout(this.pending?.timer); this.pending = undefined;
    this.deps.changed();
    this.deps.fail('The voice microphone control did not respond. Reconnect to continue from your saved room.');
  }

  close() {
    this.closed = true;
    clearTimeout(this.pending?.timer); this.pending = undefined;
  }
}
