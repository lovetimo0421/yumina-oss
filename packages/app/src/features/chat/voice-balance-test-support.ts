
import assert from 'node:assert/strict';
import type { VoiceEvent } from '../../../sandbox/voice-types';
const path = './voice-balance-client';
export const attempt = { sessionId: 'session', worldId: 'world', journeyId: 'journey', journeyEpoch: 1, cardAttemptId: 'hat-1' };
export const identity = { callId: 'call', connectionId: 'connection', epoch: 1, attempt, providerState: 'open', accountingState: 'pending', receiptAvailability: 'live' };
export const capability = { available: true, funding: 'balance', transport: 'server-ws-v1', turnControl: 'server-v1', maxDurationSeconds: 300, finishAcknowledged: true, reservationCredits: 100 };
async function implementation() { const m = await import(path).catch(() => ({})); assert.equal(typeof m.BalanceVoiceClient, 'function', 'scoped native client is implemented'); return m as typeof import('./voice-balance-client'); }
export class FakeSocket {
  readyState = 0; bufferedAmount = 0; binaryType = ''; sent: any[] = [];
  onopen: any; onmessage: any; onclose: any; onerror: any;
  send(v: any) { this.sent.push(typeof v === 'string' ? JSON.parse(v) : v); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  event(v: unknown) { this.onmessage?.({ data: typeof v === 'object' && v instanceof ArrayBuffer ? v : JSON.stringify(v) }); }
}
export function audioFixture() {
  return { frames: null as any, failure: null as any, playedSamples: 0, pendingSamples: 0, closed: 0, flushed: 0, paused: false,
    ready: async () => {}, capture: async function(_stream: any, _epoch: number, frames: any, failure: any) { this.frames = frames; this.failure = failure; },
    pauseInput(value: boolean) { this.paused = value; }, enqueue(pcm: Uint8Array) { this.pendingSamples += pcm.length / 2; },
    flush() { this.flushed++; this.pendingSamples = 0; const p = this.playedSamples; this.playedSamples = 0; return p; },
    setMuted() {}, setSpatial() {}, close() { this.closed++; this.flush(); } };
}
export async function fixture(reply?: (url: string, options?: RequestInit) => unknown, observe?: (event: VoiceEvent) => void) {
  const { BalanceVoiceClient } = await implementation(), events: VoiceEvent[] = [], socket = new FakeSocket(), audio = audioFixture();
  let scope: typeof attempt | null = attempt, now = 0, audioTick = () => {};
  const urls: string[] = [];
  const track = { stops: 0, enabled: true, readyState: 'live', onended: null as any, stop() { this.stops++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const client = new BalanceVoiceClient({ sessionId: 'session', current: () => scope !== null, currentAttempt: () => scope,
    fetch: async (url, opts) => { urls.push(String(url)); const value = await reply?.(String(url), opts) ?? { ...identity, status: 'pending', finalSeq: 0, finals: [] }; return Response.json({ ...(String(url).endsWith('/start') ? { socketPath: '/api/voice/session/balance/socket' } : {}), ...(value as object) }); },
    createSocket: () => socket as unknown as WebSocket, now: () => now,
    emit: e => { events.push(e); observe?.(e); }, connectionId: 'connection', tick: callback => { audioTick = callback; return 1 as any; }, untick() {} });
  return { client, socket, audio, events, urls, stream, track, poll: () => audioTick(), advance: (ms: number) => { now += ms; }, replace: () => { scope = null; } };
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
export async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const promise = f.client.start({ instructions: 'Hat direction', context: '', voice: 'marin' }, f.stream, f.audio);
  await tick(); f.socket.open(); f.socket.event({ type: 'bound', epoch: 1 }); f.socket.event({ type: 'ready', epoch: 1, playbackEpoch: 0 }); await promise;
}
export function output(f: Awaited<ReturnType<typeof fixture>>, samples = 2400, sequence = 0, offset = 0) {
  f.socket.event({ type: 'audio', epoch: 1, playbackEpoch: 1, sequence, responseId: 'response', part: 0, offset, samples });
  const buffer = new ArrayBuffer(24 + samples * 2), bytes = new Uint8Array(buffer), view = new DataView(buffer);
  bytes.set([89,86,49,2]); view.setUint32(4, 1); view.setUint32(8, 1); view.setUint32(12, sequence); view.setUint32(16, 0); view.setUint32(20, offset);
  f.socket.event(buffer);
}
