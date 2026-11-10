/** Segment continuous 24 kHz PCM for the avatar. These are audio boundaries,
 * never a claim that the model has finished a semantic sentence. */
export class LiveVoiceSegments {
  private active = false;
  private allowed = true;
  private forwarding = false;
  private suppressed = false;
  private closed = false;
  private quietMs = 0;
  private preroll?: Uint8Array;
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private streaming = false;
  constructor(private callbacks: { start(): void; pcm(data: Uint8Array): void; end(): void; activity?(active: boolean): void }, private startupBufferMs = 0) {
    this.startupBufferMs = Number.isFinite(startupBufferMs) ? Math.max(0, Math.min(3000, startupBufferMs)) : 0;
  }
  private clearBuffer() { this.buffered = []; this.bufferedBytes = 0; this.streaming = false; }
  private flushBuffer() {
    const packets = this.buffered; this.buffered = []; this.bufferedBytes = 0; this.streaming = true;
    for (const packet of packets) if (!this.closed && this.forwarding) this.callbacks.pcm(packet);
  }
  private forward(data: Uint8Array) {
    if (this.streaming || !this.startupBufferMs) { this.callbacks.pcm(data); return; }
    this.buffered.push(data); this.bufferedBytes += data.byteLength;
    if (this.bufferedBytes >= this.startupBufferMs * 48) this.flushBuffer();
  }
  /** A denied source is consumed through its quiet tail, never buffered for
   * later playback. Opening the gate mid-source cannot admit that source's tail. */
  allow(allowed: boolean) {
    this.allowed = allowed;
    if (allowed && !this.active) this.suppressed = false;
    if (!allowed) {
      this.clearBuffer();
      this.preroll = undefined;
      if (this.forwarding) { this.forwarding = false; this.callbacks.end(); }
    }
  }
  append(data: Uint8Array) {
    if (this.closed || !data.byteLength || data.byteLength % 2 || data.byteLength > 48_000) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let energy = 0;
    for (let i = 0; i < data.length; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
    const audible = Math.sqrt(energy / (data.length / 2)) >= .0015;
    this.quietMs = audible ? 0 : this.quietMs + data.byteLength / 48;
    if (!this.active) {
      if (!audible) {
        if (this.quietMs >= 1200) this.suppressed = false;
        if (this.allowed && !this.suppressed) this.preroll = data;
        return;
      }
      this.active = true;
      // Report onset synchronously before deciding to forward its first packet.
      this.callbacks.activity?.(true);
      this.forwarding = this.allowed && !this.suppressed;
      if (this.forwarding) {
        this.clearBuffer();
        this.callbacks.start();
        if (this.preroll) this.forward(this.preroll);
      }
      this.preroll = undefined;
    }
    if (this.forwarding) this.forward(data);
    if (this.quietMs >= 1200) {
      this.active = false;
      if (this.forwarding) { this.flushBuffer(); this.callbacks.end(); }
      this.forwarding = false; this.suppressed = false;
      this.callbacks.activity?.(false);
    }
  }
  interrupt() { this.clearBuffer(); this.forwarding = false; this.suppressed = true; this.quietMs = 0; this.preroll = undefined; }
  close() { this.clearBuffer(); this.closed = true; this.active = false; this.preroll = undefined; }
}
