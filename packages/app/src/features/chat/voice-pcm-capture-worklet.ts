/** Causal 65-tap windowed-sinc resampler. Input position and fractional phase
 * survive each render quantum. The 32 input-sample delay is fixed, not a timer.
 * The ring and cached rational phases are bounded independently of call age. */
export class PCMResampler {
  // toString() crosses into an isolated worklet. Declare-only types and plain
  // assignments avoid production class-field helpers from the host's closure.
  declare private ring: Float32Array;
  declare private inputCount: number;
  declare private outputCount: number;
  declare private kernels: Map<number, Float64Array>;
  declare private readonly inputRate: number;
  constructor(inputRate: number) {
    this.inputRate = inputRate;
    this.ring = new Float32Array(256);
    this.inputCount = 0;
    this.outputCount = 0;
    this.kernels = new Map();
    if (!Number.isFinite(inputRate) || inputRate < 24000 || inputRate > 192000) throw Error('Unsupported capture sample rate');
  }
  process(input: Float32Array): Float32Array {
    const output: number[] = [];
    for (const sample of input) {
      this.ring[this.inputCount % 256] = Number.isFinite(sample) ? sample : 0;
      this.inputCount++;
      while (this.outputCount * this.inputRate / 24000 < this.inputCount) {
        const position = this.outputCount * this.inputRate / 24000 - 32;
        const center = Math.floor(position), fraction = position - center;
        const key = Math.round(fraction * 1000000);
        let kernel = this.kernels.get(key);
        if (!kernel) {
          kernel = new Float64Array(65); let total = 0;
          const cutoff = .45 * 24000 / this.inputRate;
          for (let k = -32; k <= 32; k++) {
            const d = k - fraction;
            const sinc = Math.abs(d) < 1e-10 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * d) / (Math.PI * d);
            const window = .42 + .5 * Math.cos(Math.PI * k / 32) + .08 * Math.cos(2 * Math.PI * k / 32);
            kernel[k + 32] = sinc * window; total += kernel[k + 32]!;
          }
          for (let k = 0; k < 65; k++) kernel[k] = kernel[k]! / total;
          if (this.kernels.size < 256) this.kernels.set(key, kernel);
        }
        let value = 0;
        for (let k = -32; k <= 32; k++) {
          const index = center + k;
          if (index >= 0 && index < this.inputCount) value += this.ring[index % 256]! * kernel[k + 32]!;
        }
        output.push(value); this.outputCount++;
      }
    }
    return new Float32Array(output);
  }
}

// The same tested implementation is loaded by the native host as an owned Blob.
// No iframe worker capability or provider network access is involved.
export const captureWorkletSource = `const __name = (value) => value; const PCMResampler = ${PCMResampler.toString()};
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.epoch = options.processorOptions.epoch;
    this.resampler = new PCMResampler(sampleRate); this.frame = new ArrayBuffer(960);
    this.view = new DataView(this.frame); this.offset = 0; this.sequence = 0;
    this.acknowledged = -1; this.paused = false; this.closed = false;
    this.port.onmessage = ({data}) => {
      if (data.type === 'ack' && Number.isSafeInteger(data.sequence) && data.sequence > this.acknowledged && data.sequence < this.sequence) this.acknowledged = data.sequence;
      if (data.type === 'pause') { this.paused = data.paused === true; this.offset = 0; this.resampler = new PCMResampler(sampleRate); }
      if (data.type === 'stop') this.closed = true;
    };
  }
  process(inputs, outputs) {
    for (const channels of outputs) for (const channel of channels) channel.fill(0);
    if (this.closed) return false;
    if (this.paused || !inputs[0] || !inputs[0][0]) return true;
    const samples = this.resampler.process(inputs[0][0]);
    for (const sample of samples) {
      const clamped = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(this.offset * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
      if (++this.offset === 480) {
        if (this.sequence - this.acknowledged > 10) { this.port.postMessage({type:'failure'}); this.closed = true; return false; }
        this.port.postMessage({type:'pcm', epoch:this.epoch, sequence:this.sequence++, pcm:this.frame}, [this.frame]);
        this.frame = new ArrayBuffer(960); this.view = new DataView(this.frame); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('yumina-balance-capture-v1', Capture);`;
