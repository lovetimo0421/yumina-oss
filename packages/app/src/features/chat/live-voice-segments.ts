/** Segment continuous 24 kHz PCM for the avatar. These are audio boundaries,
 * never a claim that the model has finished a semantic sentence. */
export class LiveVoiceSegments {
  private active = false;
  private suppressed = false;
  private closed = false;
  private quietMs = 0;
  private preroll?: Uint8Array;
  constructor(private callbacks: { start(): void; pcm(data: Uint8Array): void; end(): void }) {}
  append(data: Uint8Array) {
    if (this.closed || !data.byteLength || data.byteLength % 2 || data.byteLength > 48_000) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let energy = 0;
    for (let i = 0; i < data.length; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
    const audible = Math.sqrt(energy / (data.length / 2)) >= .0015;
    this.quietMs = audible ? 0 : this.quietMs + data.byteLength / 48;
    if (this.suppressed) {
      if (this.quietMs >= 1200) { this.suppressed = false; this.quietMs = 0; }
      return;
    }
    if (!this.active) {
      if (!audible) { this.preroll = data; return; }
      this.active = true; this.callbacks.start();
      if (this.preroll) this.callbacks.pcm(this.preroll);
      this.preroll = undefined;
    }
    this.callbacks.pcm(data);
    if (this.quietMs >= 1200) { this.active = false; this.callbacks.end(); }
  }
  interrupt() { this.active = false; this.suppressed = true; this.quietMs = 0; this.preroll = undefined; }
  close() { this.closed = true; this.active = false; this.preroll = undefined; }
}
