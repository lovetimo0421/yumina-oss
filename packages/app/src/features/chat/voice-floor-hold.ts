/** Holds the microphone back from a live model while the character is speaking.
 * Continuous models yield the moment they hear the user, which cuts their sentence
 * in half. While held, captured audio is queued (never dropped) and the model hears
 * silence; on release the queue plays out, skipping only real pauses (a third of a
 * second or more of quiet) to catch up, so soft consonants inside words survive. */
export const FLOOR_HOLD_WORKLET = `
class FloorHold extends AudioWorkletProcessor {
  constructor() {
    super(); this.held = false; this.queue = []; this.max = Math.ceil(sampleRate * 20 / 128); this.pause = Math.ceil(sampleRate * .35 / 128); this.loud = 0;
    this.port.onmessage = ({data}) => { if (data && data.type === 'held') this.held = data.held === true; };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0]; if (!out) return true;
    const input = inputs[0] && inputs[0][0];
    if (!this.held && !this.queue.length) { if (input) out.set(input); else out.fill(0); return true; }
    const block = input ? Float32Array.from(input) : new Float32Array(out.length); let energy = 0;
    for (let i = 0; i < block.length; i++) energy += block[i] * block[i];
    const quiet = Math.sqrt(energy / block.length) < 0.01;
    this.queue.push({block, quiet});
    if (!quiet) this.loud++;
    if (this.queue.length > this.max && !this.queue.shift().quiet) this.loud--;
    if (this.held) { out.fill(0); return true; }
    // Catch up only through real pauses: drop a quiet block when the stretch of quiet
    // ahead of it is longer than a pause, or when no speech is left in the queue.
    while (this.queue.length > 1 && this.queue[0].quiet) {
      let run = 0; while (run < this.queue.length && run <= this.pause && this.queue[run].quiet) run++;
      if (run <= this.pause && this.loud) break;
      this.queue.shift();
    }
    const next = this.queue.shift(); if (!next.quiet) this.loud--;
    out.fill(0); out.set(next.block.subarray(0, out.length));
    return true;
  }
}
registerProcessor('yumina-floor-hold', FloorHold);
`;

export interface FloorHold { node: AudioWorkletNode; hold(held: boolean): void; close(): void }

/** Fails closed to null: the caller connects the microphone directly instead. */
export async function createFloorHold(context: AudioContext): Promise<FloorHold | null> {
  if (!context.audioWorklet) return null;
  const url = URL.createObjectURL(new Blob([FLOOR_HOLD_WORKLET], { type: 'text/javascript' }));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([context.audioWorklet.addModule(url), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Floor hold unavailable')), 1000);
    })]);
    const node = new AudioWorkletNode(context, 'yumina-floor-hold', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    let held = false;
    return {
      node,
      hold(value) { if (value === held) return; held = value; node.port.postMessage({ type: 'held', held: value }); },
      close() { node.disconnect(); node.port.close(); },
    };
  } catch { return null; }
  finally { clearTimeout(deadline); URL.revokeObjectURL(url); }
}
