// A Blob module keeps this processor in the app build without a public worker
// endpoint. Its context is explicitly 24 kHz; every output sample remains zero.
export const AVATAR_PCM_WORKLET = `
class AvatarPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    if (sampleRate !== 24000) throw new Error("Avatar PCM requires 24 kHz");
    this.epoch = 0; this.active = false; this.drainFrames = null; this.continuous = false;
    this.buffer = new ArrayBuffer(9600); this.view = new DataView(this.buffer); this.offset = 0;
    this.preroll = new Float32Array(2400); this.prerollOffset = 0; this.prerollLength = 0; this.prerollEnabled = true;
    this.port.onmessage = ({ data }) => {
      if (data.type === "continuous") {
        this.continuous = true; this.active = false; this.offset = 0;
        this.prerollLength = 0; this.prerollOffset = 0;
      } else if (data.type === "begin" && !this.continuous) {
        if (this.active) this.finish();
        this.epoch = data.epoch; this.active = true; this.drainFrames = null; this.offset = 0;
        if (this.prerollEnabled) {
          const start = (this.prerollOffset - this.prerollLength + this.preroll.length) % this.preroll.length;
          for (let index = 0; index < this.prerollLength; index++) this.write(this.preroll[(start + index) % this.preroll.length]);
        }
        this.prerollLength = 0; this.prerollOffset = 0;
      } else if (data.type === "clear") {
        this.epoch = data.epoch; this.active = false; this.drainFrames = null; this.offset = 0;
        this.prerollEnabled = false; this.prerollLength = 0; this.prerollOffset = 0;
      } else if (data.type === "drain" && data.epoch === this.epoch && this.active) {
        this.drainFrames = Math.max(0, Math.min(12000, data.frames));
        if (!this.drainFrames) this.finish();
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const pcm = this.buffer.slice(0, this.offset);
    this.port.postMessage({ type: this.continuous ? "live-pcm" : "pcm", epoch: this.epoch, pcm }, [pcm]);
    this.offset = 0;
  }
  finish() {
    this.flush(); this.active = false; this.drainFrames = null;
    this.prerollEnabled = true;
    this.port.postMessage({ type: "drained", epoch: this.epoch });
  }
  write(sample) {
    this.view.setInt16(this.offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    this.offset += 2;
    if (this.offset === this.buffer.byteLength) this.flush();
  }
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0] || [];
    const length = channels[0]?.length || outputs[0]?.[0]?.length || 128;
    for (let index = 0; index < length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] || 0;
      if (channels.length) sample /= channels.length;
      sample = Math.max(-1, Math.min(1, sample));
      if (this.continuous) { this.write(sample); continue; }
      if (!this.active) {
        if (this.prerollEnabled) {
          this.preroll[this.prerollOffset] = sample;
          this.prerollOffset = (this.prerollOffset + 1) % this.preroll.length;
          this.prerollLength = Math.min(this.preroll.length, this.prerollLength + 1);
        }
        continue;
      }
      this.write(sample);
      if (this.drainFrames !== null && --this.drainFrames <= 0) this.finish();
    }
    return true;
  }
}
registerProcessor("yumina-avatar-pcm", AvatarPCM);
`;
