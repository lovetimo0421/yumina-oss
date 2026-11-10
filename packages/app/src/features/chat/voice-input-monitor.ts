/** This is an initial digital-silence veto, not a speech/noise classifier. Any
 * nonzero sample, however quiet, permanently makes recognition eligible. */
export type VoiceInputEvidence = 'silent' | 'signal' | 'unknown';
export interface VoiceInputMonitor { probe(): Promise<VoiceInputEvidence>; close(): void }

// The render thread sees every quantum; a UI analyser sampled every 50ms does
// not. No recording, waveform or words leave this node. Its output is silence.
export const VOICE_INPUT_WORKLET = `
class VoiceInputMonitor extends AudioWorkletProcessor {
  constructor() {
    super(); this.signal = false; this.unknown = false; this.nextFrame = null; this.probes = [];
    this.port.onmessage = ({data}) => {
      if (data.type === 'invalidate') this.unknown = true;
      if (data.type === 'probe' && this.probes.length < 64) this.probes.push(data.id);
    };
  }
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0] || [];
    const length = outputs[0]?.[0]?.length || 128;
    if (this.nextFrame !== null && currentFrame !== this.nextFrame) this.unknown = true;
    this.nextFrame = currentFrame + length;
    if (!channels.length) this.unknown = true;
    for (const channel of channels) {
      if (channel.length !== length) this.unknown = true;
      for (const sample of channel) {
        if (!Number.isFinite(sample)) this.unknown = true;
        else if (sample !== 0) this.signal = true;
      }
    }
    const evidence = this.signal ? 'signal' : this.unknown ? 'unknown' : 'silent';
    for (const id of this.probes) this.port.postMessage({id, evidence});
    this.probes.length = 0;
    return true;
  }
}
registerProcessor('yumina-voice-input', VoiceInputMonitor);
`;

const unknownMonitor = (): VoiceInputMonitor => ({ probe: async () => 'unknown', close() {} });

/** Attach and observe an initial quantum before the raw track enters WebRTC.
 * Any unavailable capability, suspended context or missed reply fails open. */
export async function createVoiceInputMonitor(context: AudioContext, source: MediaStreamAudioSourceNode): Promise<VoiceInputMonitor> {
  if (!context.audioWorklet || context.state !== 'running') return unknownMonitor();
  let node: AudioWorkletNode | undefined, closed = false, uncertain = false, seq = 0;
  const pending = new Map<number, { resolve(value: VoiceInputEvidence): void; timer: ReturnType<typeof setTimeout> }>();
  const invalidate = () => {
    uncertain = true;
    node?.port.postMessage({ type: 'invalidate' });
    for (const item of pending.values()) { clearTimeout(item.timer); item.resolve('unknown'); }
    pending.clear();
  };
  const stateChanged = () => { if (context.state !== 'running') invalidate(); };
  context.addEventListener('statechange', stateChanged);
  const monitor: VoiceInputMonitor = {
    probe() {
      if (closed || uncertain || !node || context.state !== 'running') { invalidate(); return Promise.resolve('unknown'); }
      return new Promise(resolve => {
        const id = ++seq;
        pending.set(id, { resolve, timer: setTimeout(invalidate, 200) });
        node!.port.postMessage({ type: 'probe', id });
      });
    },
    close() {
      if (closed) return; closed = true; invalidate();
      context.removeEventListener('statechange', stateChanged);
      if (node) {
        try { source.disconnect(node); } catch { /* source may already be detached */ }
        node.disconnect(); node.port.onmessage = null; node.port.close();
      }
    },
  };
  const url = URL.createObjectURL(new Blob([VOICE_INPUT_WORKLET], { type: 'text/javascript' }));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([context.audioWorklet.addModule(url), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Input monitor unavailable')), 1000);
    })]);
    if (uncertain || context.state !== 'running') { monitor.close(); return unknownMonitor(); }
    node = new AudioWorkletNode(context, 'yumina-voice-input', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.onprocessorerror = invalidate;
    node.port.onmessage = ({ data }) => {
      const item = pending.get(data?.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(data.id);
      item.resolve(!uncertain && context.state === 'running' && (data.evidence === 'silent' || data.evidence === 'signal') ? data.evidence : 'unknown');
    };
    source.connect(node); node.connect(context.destination);
    await monitor.probe();
    return monitor;
  } catch { monitor.close(); return unknownMonitor(); }
  finally { clearTimeout(deadline); URL.revokeObjectURL(url); }
}
