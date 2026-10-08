import { isVoiceAttempt, isVoiceFinishResult, sameVoiceAttempt, type VoiceAttempt, type VoiceEvent, type VoiceFinishResult, type VoiceProviderState, type VoiceAccountingState, type VoicePose } from '../../../sandbox/voice-types';
import type { BalanceAudio, PCMCaptureFrame } from './voice-pcm-playback';

type Recipe = { instructions: string; context: string; voice: 'marin' | 'cedar' };
type Final = { itemId: string; contentIndex: number; role: 'user' | 'assistant'; text: string };
type Group = { finalSeq: number; kind: 'response' | 'transcription'; finals: Final[] };
type Drain = { cursor: number };
type Receipt = { callId: string; connectionId: string | null; epoch: number; attempt: VoiceAttempt; providerState: VoiceProviderState; accountingState: VoiceAccountingState;
  status: 'pending' | 'finished' | 'incomplete' | 'unavailable' | 'not-started'; receiptAvailability: 'live' | 'redacted'; finalSeq?: number; finals?: Group[]; socketPath?: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const exact = (v: object, keys: string[]) => Reflect.ownKeys(v).every(k => typeof k === 'string' && keys.includes(k));
export function validBalanceRecipe(v: Recipe): boolean {
  return !!v.instructions.trim() && v.context.length <= 4000 && v.instructions.length + v.context.length <= 12000 && new TextEncoder().encode(v.instructions + v.context).length <= 12000;
}
/** Validate the actual B3 HTTP journal, not provider events or browser captions. */
export function parseBalanceReceipt(value: unknown): Receipt {
  if (!object(value) || !exact(value, ['callId','connectionId','epoch','attempt','providerState','accountingState','status','receiptAvailability','finalSeq','finals','socketPath'])
    || !id(value.callId) || !(value.connectionId === null || id(value.connectionId)) || !uint(value.epoch) || !isVoiceAttempt(value.attempt)
    || !['open','unconfirmed','close-confirmed','hard-expired','not-created'].includes(value.providerState as string) || !['pending','complete','incomplete','not-applicable'].includes(value.accountingState as string)) throw Error('Invalid voice receipt');
  if (value.status === 'unavailable') {
    if (value.receiptAvailability !== 'redacted' || 'finalSeq' in value || 'finals' in value) throw Error('Invalid redacted voice receipt');
  } else if (value.status === 'not-started') {
    if (value.receiptAvailability !== 'live' || value.providerState !== 'not-created' || 'finalSeq' in value || 'finals' in value) throw Error('Invalid never-started voice receipt');
  } else {
    if (!['pending','finished','incomplete'].includes(value.status as string) || value.receiptAvailability !== 'live' || !uint(value.finalSeq) || !Array.isArray(value.finals) || value.finals.length > 100) throw Error('Invalid voice journal');
    if (value.status === 'finished' && (value.providerState !== 'close-confirmed' || value.accountingState !== 'complete' || !id(value.connectionId))) throw Error('Unconfirmed voice finish');
    for (const group of value.finals) {
      if (!object(group) || !exact(group, ['finalSeq','kind','finals']) || !uint(group.finalSeq) || group.finalSeq === 0 || group.finalSeq > value.finalSeq || !['response','transcription'].includes(group.kind as string) || !Array.isArray(group.finals) || group.finals.length < 1 || group.finals.length > 16 || new TextEncoder().encode(JSON.stringify(group.finals)).length > 24000) throw Error('Invalid voice final group');
      const parts = new Set<string>();
      for (const final of group.finals) {
        if (!object(final) || !exact(final, ['itemId','contentIndex','role','text']) || !id(final.itemId) || !uint(final.contentIndex) || !['user','assistant'].includes(final.role as string) || typeof final.text !== 'string' || !final.text.trim() || final.text.length > 8000) throw Error('Invalid voice final');
        const key = `${final.itemId}:${final.contentIndex}`; if (parts.has(key)) throw Error('Duplicate voice final'); parts.add(key);
      }
    }
  }
  if (value.socketPath !== undefined && typeof value.socketPath !== 'string') throw Error('Invalid voice socket');
  return value as unknown as Receipt;
}

export interface BalanceClientDependencies {
  sessionId: string; connectionId: string;
  /** Current host account/session/capability fence; independent of local stop. */
  current(): boolean;
  currentAttempt(): VoiceAttempt | null;
  fetch: typeof fetch; apiBase?: string;
  createSocket(url: string): WebSocket;
  emit(event: VoiceEvent): void;
  now?(): number;
  tick?(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  untick?(timer: ReturnType<typeof setInterval>): void;
}

/** One reservation/worker socket. Recovery never resends microphone history,
 * rebinds a socket, opens a provider, or selects a caller-authored attempt. */
export class BalanceVoiceClient {
  private receipt: Receipt | null = null;
  private cursor = 0;
  private observedFinalSeq = 0;
  private delivered = new Map<string, { finalSeq: number; index: number }>();
  private groups = new Map<number, string>();
  private socket: WebSocket | null = null;
  private audio: BalanceAudio | null = null;
  private stream: MediaStream | null = null;
  private disposed = false;
  private stopped = false;
  private configured = false;
  private inputAdmitted = false;
  private inputRevision = -1;
  private abort = new AbortController();
  private cleanupAbort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private readyResolve?: () => void;
  private readyReject?: (e: Error) => void;
  private replaying: Promise<Receipt | null> | null = null;
  private controlSequence = 0;
  private audioSequence = 0;
  private capturedSequence = 0;
  private captureSince = 0;
  private outputSequence = 0;
  private playbackEpoch = 0;
  private suppressedEpoch = -1;
  private responseId: string | null = null;
  private outputPart = -1;
  private outputOffset = 0;
  private outputReceived = 0;
  private played = 0;
  private lastProgress = 0;
  private metadata: Record<string, unknown> | null = null;
  private muted = { input: false, output: false };
  private pendingContext: string | null = null;
  private contextRequest = -1;
  private contextConfiguring: number | null = null;
  private contextApplied = -1;
  private lastContextSent = -1000;
  private replayRequested = 0;
  private recipe: Recipe | null = null;
  private bound = false;
  private controls: number[] = [];
  private readonly now: () => number;
  private readonly initialAttempt: VoiceAttempt | null;
  get isInputAdmitted() { return this.inputAdmitted && this.configured && !this.stopped; }
  constructor(private readonly deps: BalanceClientDependencies) { this.now = deps.now ?? (() => performance.now()); const attempt = deps.currentAttempt(); this.initialAttempt = attempt ? { ...attempt } : null; }
  get boundAttempt(): VoiceAttempt | null { return this.receipt?.attempt ?? this.initialAttempt; }
  private base() { return `${this.deps.apiBase ?? ''}/api/voice/${encodeURIComponent(this.deps.sessionId)}/balance`; }
  private current() { return !this.disposed && this.deps.current(); }
  private ownsAttempt() {
    const attempt = this.deps.currentAttempt();
    return this.current() && !!attempt && (!this.receipt || sameVoiceAttempt(attempt, this.receipt.attempt));
  }
  private checkReceipt(value: Receipt) {
    const attempt = this.deps.currentAttempt();
    if (!this.current() || !attempt || !sameVoiceAttempt(value.attempt, attempt) || value.attempt.sessionId !== this.deps.sessionId) throw Error('Voice scope is unavailable');
    if (this.receipt && (value.callId !== this.receipt.callId || value.connectionId !== this.receipt.connectionId || !sameVoiceAttempt(value.attempt, this.receipt.attempt) || value.epoch < this.receipt.epoch)) throw Error('Voice receipt belongs to another call');
    if (this.receipt?.status === 'unavailable' && value.receiptAvailability === 'live') throw Error('Voice receipt is redacted');
    // A bounded page or no-emission prefetch can observe an undelivered tail.
    // Keep that progress independently of older receipt assignments.
    if (value.receiptAvailability === 'live' && value.finalSeq !== undefined) this.observedFinalSeq = Math.max(this.observedFinalSeq, value.finalSeq);
  }
  private async request(path: string, method = 'GET', body?: unknown, signal = this.cleanupAbort.signal): Promise<unknown> {
    if (!this.current()) throw Error('Voice scope is unavailable');
    const response = await this.deps.fetch(path, { method, credentials: 'include', cache: 'no-store', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Voice-Connection-Id': this.receipt?.connectionId ?? this.deps.connectionId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!this.current()) throw Error('Voice scope is unavailable');
    if (!response.ok) throw Error('Voice cleanup is unavailable. Try again or continue in text.');
    return response.json();
  }
  private accept(value: Receipt, drain?: Drain) {
    this.checkReceipt(value);
    if (value.status === 'unavailable' || value.status === 'not-started') { if (value.status === 'unavailable') { this.delivered.clear(); this.groups.clear(); } this.receipt = value; return; }
    if (value.finalSeq! < this.cursor) {
      if (drain) throw Error('Voice journal cursor regressed. Retry cleanup.');
      return; // An earlier concurrent cleanup snapshot has no new authority.
    }
    const groups = value.finals!;
    for (const group of groups) {
      const cursor = drain?.cursor ?? this.cursor;
      if (group.finalSeq > cursor + 1) throw Error('Voice receipt has a gap. Retry cleanup.');
      // Keep canonical content/membership history across subscriber drains.
      // Clearing delivery progress must never make a changed final acceptable.
      const signature = JSON.stringify([group.kind, group.finals.map(final => [final.role, final.itemId, final.contentIndex, final.text])]);
      const previousGroup = this.groups.get(group.finalSeq);
      if (previousGroup !== undefined && previousGroup !== signature) throw Error('Voice final group changed');
      for (const [index, final] of group.finals.entries()) {
        const previous = this.delivered.get(`${final.role}:${final.itemId}:${final.contentIndex}`);
        if (previous && (previous.finalSeq !== group.finalSeq || previous.index !== index)) throw Error('Voice final identity changed');
      }
      if (group.finalSeq <= cursor) continue;
      this.groups.set(group.finalSeq, signature);
      for (const [index, final] of group.finals.entries()) {
        this.checkReceipt(value);
        const key = `${final.role}:${final.itemId}:${final.contentIndex}`;
        const previous = this.delivered.get(key);
        if (drain || previous === undefined) {
          this.deps.emit({ type: 'transcript', role: final.role, id: `${value.callId}:${key}`, text: final.text, final: true,
            native: { attempt: { ...value.attempt }, callId: value.callId, connectionId: value.connectionId!, epoch: value.epoch, finalSeq: group.finalSeq, itemId: final.itemId, contentIndex: final.contentIndex, groupIndex: index, groupSize: group.finals.length, delivery: group.kind === 'response' ? 'generated' : 'input' } });
          this.delivered.set(key, { finalSeq: group.finalSeq, index });
        }
      }
      if (drain) drain.cursor = group.finalSeq;
      this.cursor = Math.max(this.cursor, group.finalSeq);
    }
    this.receipt = value;
  }
  async recover(): Promise<void> {
    if (!this.current() || !this.deps.currentAttempt()) return;
    // Init may precede sandbox subscription. Retain identity without marking
    // any final delivered; the explicit finish caller drains the journal.
    await this.replay(true, false);
  }
  private replay(recovery = false, deliver = true, drain?: Drain): Promise<Receipt | null> {
    if (!drain && this.replaying) return this.replaying;
    const replaying = (async () => {
      let value: Receipt | null = null;
      for (let page = 0; page < 4; page++) {
        const path = recovery || !this.receipt ? `${this.base()}/recover` : `${this.base()}/${encodeURIComponent(this.receipt.callId)}/status`;
        const raw = await this.request(`${path}?afterFinalSeq=${drain?.cursor ?? this.cursor}`);
        if (object(raw) && exact(raw, ['status']) && raw.status === 'not-found') return null;
        value = parseBalanceReceipt(raw);
        if (!deliver) { this.checkReceipt(value); if (value.finalSeq === undefined || value.finalSeq >= this.cursor) this.receipt = value; return value; }
        this.accept(value, drain);
        const cursor = drain?.cursor ?? this.cursor;
        if (value.finalSeq === undefined || cursor === value.finalSeq && cursor >= this.replayRequested) return value;
        if (!value.finals?.length) throw Error('Voice journal is not fully available. Retry cleanup.');
      }
      throw Error('Voice receipt replay exceeded its bound');
    })();
    // Explicit finish owns a fresh cursor and must not borrow an in-flight
    // background replay (including a page-init prefetch that emits nothing).
    if (drain) return replaying;
    this.replaying = replaying.finally(() => { this.replaying = null; });
    return this.replaying;
  }
  async start(recipe: Recipe, stream: MediaStream, audio: BalanceAudio): Promise<void> {
    this.stream = stream; this.audio = audio;
    try { await this.connect(recipe); }
    catch (error) { this.stop(); throw error; }
  }
  private async connect(recipe: Recipe): Promise<void> {
    if (!validBalanceRecipe(recipe) || this.recipe || !this.current() || !this.deps.currentAttempt()) throw Error('Voice scope or context is unavailable');
    this.recipe = { ...recipe }; this.captureSince = this.now();
    const raw = await this.request(`${this.base()}/start`, 'POST', this.recipe, this.abort.signal);
    const value = parseBalanceReceipt(raw); this.accept(value);
    if (this.stopped) { void this.finish().catch(() => {}); throw Error('Voice stopped'); }
    if (value.status !== 'pending' || value.connectionId !== this.deps.connectionId || value.socketPath !== `/api/voice/${encodeURIComponent(this.deps.sessionId)}/balance/socket`) throw Error('Voice call is already closing. Continue in text.');
    const base = new URL(this.deps.apiBase || '/', typeof location === 'undefined' ? 'https://yumina.invalid' : location.href);
    const url = new URL(value.socketPath, base); if (url.origin !== base.origin || url.search || url.hash) throw Error('Invalid voice socket');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.deps.createSocket(url.href); this.socket = socket; socket.binaryType = 'arraybuffer';
    const ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    socket.onopen = () => { if (!this.stopped && this.current()) socket.send(JSON.stringify({ type: 'bind', callId: value.callId, connectionId: value.connectionId, epoch: value.epoch, recipe: this.recipe })); };
    socket.onmessage = event => { if (this.stopped) return; if (!this.ownsAttempt()) { this.stop(); return; } try { this.receive(event.data); } catch { this.failure(); } };
    socket.onclose = socket.onerror = () => { if (!this.stopped) this.failure(); };
    await ready;
    if (this.stopped || !this.current()) throw Error('Voice stopped');
    this.captureSince = this.now();
    await this.audio!.capture(this.stream!, this.receipt!.epoch, frame => this.capture(frame), () => this.failure());
    if (this.stopped || !this.current()) throw Error('Voice stopped');
    this.applyMute();
    this.timer = (this.deps.tick ?? setInterval)(() => this.pollAudio(), 200);
  }
  private control(type: string, fields: object = {}) {
    if (!this.bound || !this.socket || this.socket.readyState !== 1 || !this.receipt) return;
    if (this.socket.bufferedAmount > 9720) throw Error('Voice socket is stalled');
    const now = this.now(); this.controls = this.controls.filter(t => now - t < 1000);
    if (this.controls.length >= 10) throw Error('Too many voice controls'); this.controls.push(now);
    const seq = this.controlSequence++;
    this.socket.send(JSON.stringify({ type, epoch: this.receipt.epoch, seq, ...fields }));
    return seq;
  }
  private capture(frame: PCMCaptureFrame) {
    if (this.stopped) return;
    if (!this.ownsAttempt()) { this.stop(); return; }
    try {
      if (!uint(frame.epoch) || frame.epoch !== this.receipt?.epoch || frame.sequence !== this.capturedSequence || !(frame.pcm instanceof ArrayBuffer) || frame.pcm.byteLength !== 960) throw Error('Invalid microphone frame');
      this.capturedSequence++;
      if (!this.configured || !this.inputAdmitted || this.muted.input) return;
      if ((this.audioSequence + 1) * 20 > this.now() - this.captureSince + 200 || !this.socket || this.socket.readyState !== 1 || this.socket.bufferedAmount + 972 > 9720) throw Error('Microphone queue is stalled');
      const buffer = new ArrayBuffer(972), bytes = new Uint8Array(buffer), view = new DataView(buffer);
      bytes.set([89,86,49,1]); view.setUint32(4, frame.epoch); view.setUint32(8, this.audioSequence++); bytes.set(new Uint8Array(frame.pcm), 12);
      this.socket.send(buffer);
    } catch { this.failure(); }
  }
  private receive(data: unknown) {
    if (data instanceof ArrayBuffer) { this.receivePCM(data); return; }
    if (typeof data !== 'string' || data.length > 16384 || this.metadata) throw Error('Invalid voice packet');
    const event: unknown = JSON.parse(data);
    if (!object(event) || !uint(event.epoch)) throw Error('Invalid voice event');
    if (event.type === 'bound') {
      if (this.bound || !this.receipt || event.epoch < this.receipt.epoch || !exact(event, ['type','epoch'])) throw Error('Invalid voice owner');
      this.receipt = { ...this.receipt, epoch: event.epoch }; this.bound = true; return;
    }
    if (!this.bound || event.epoch !== this.receipt?.epoch) throw Error('Stale voice owner');
    if (event.type === 'ready') {
      if (!uint(event.playbackEpoch) || !exact(event, ['type','epoch','playbackEpoch'])) throw Error('Invalid voice ready');
      this.configured = this.contextConfiguring === null;
      if (this.inputRevision < 0) this.inputAdmitted = true;
      this.playbackEpoch = Math.max(this.playbackEpoch, event.playbackEpoch); this.audio?.pauseInput(this.muted.input || !this.configured || !this.inputAdmitted);
      this.readyResolve?.(); this.readyResolve = undefined; return;
    }
    if (event.type === 'input-status') {
      if (!exact(event, ['type','epoch','revision','status']) || !uint(event.revision) || event.revision <= this.inputRevision || !['paused','listening'].includes(event.status as string)) throw Error('Invalid voice input admission');
      const wasAdmitted = this.inputAdmitted;
      this.inputRevision = event.revision; this.inputAdmitted = event.status === 'listening';
      this.audio?.pauseInput(this.muted.input || !this.configured || !this.inputAdmitted);
      if (!this.inputAdmitted || !wasAdmitted) this.deps.emit({ type: 'status', status: 'connected', phase: 'live', code: this.inputAdmitted ? 'VOICE_INPUT_RESUMED' : 'VOICE_INPUT_PAUSED', message: this.inputAdmitted ? 'Microphone listening again. Please repeat any speech from the pause.' : 'Microphone paused while voice access is checked. Speech during this pause is not accepted. Please wait, then repeat.' });
      this.deps.emit({ type: 'activity', status: this.inputAdmitted ? 'listening' : 'thinking' });
      return;
    }
    if (event.type === 'error') {
      if (!exact(event, ['type','epoch','code','reason']) || typeof event.code !== 'string' || !/^VOICE_[A-Z_]{1,64}$/.test(event.code)
        || (event.reason !== undefined && (event.code !== 'VOICE_DEADLINE' || !['wall','configuration','playback','client-write','input-age'].includes(event.reason as string)))) throw Error('Invalid voice error');
      this.failure(event.code, event.reason as Extract<VoiceEvent, { type: 'status' }>['reason']); return;
    }
    if (event.type === 'audio') {
      if (!exact(event, ['type','epoch','playbackEpoch','sequence','responseId','part','offset','samples']) || !uint(event.playbackEpoch) || !uint(event.sequence) || event.sequence !== this.outputSequence || !id(event.responseId) || !uint(event.part) || !uint(event.offset) || !uint(event.samples) || event.samples < 1 || event.samples > 2400) throw Error('Invalid voice audio identity');
      this.metadata = event; return;
    }
    if (event.type === 'flush') {
      if (!exact(event, ['type','epoch','playbackEpoch','delivery']) || !uint(event.playbackEpoch) || event.delivery !== 'interrupted' || event.playbackEpoch < this.playbackEpoch) throw Error('Invalid voice flush');
      this.audio?.flush(); this.suppressedEpoch = Math.max(this.suppressedEpoch, event.playbackEpoch - 1); this.playbackEpoch = event.playbackEpoch;
      this.responseId = null; this.outputPart = -1; this.outputOffset = this.outputReceived = this.played = 0;
      this.deps.emit({ type: 'activity', status: this.inputAdmitted ? 'listening' : 'thinking' }); return;
    }
    if (event.type === 'final') {
      if (!exact(event, ['type','epoch','finalSeq','delivery','attempt']) || !uint(event.finalSeq) || !['generated','input'].includes(event.delivery as string) || !isVoiceAttempt(event.attempt) || !sameVoiceAttempt(event.attempt, this.receipt!.attempt)) throw Error('Invalid voice final notification');
      this.replayRequested = Math.max(this.replayRequested, event.finalSeq);
      void this.replay().catch(() => this.failure()); return;
    }
    if (event.type === 'context-status') {
      if (!exact(event, ['type','epoch','revision','status']) || !uint(event.revision) || event.revision > this.contextRequest || event.revision <= this.contextApplied || !['pending','configuring','applied'].includes(event.status as string)) throw Error('Invalid voice context acknowledgement');
      if (event.status === 'configuring') { if (this.contextConfiguring !== null) throw Error('Overlapping voice context'); this.contextConfiguring = event.revision; this.configured = false; this.audio?.pauseInput(true); }
      if (event.status === 'applied') { if (event.revision !== this.contextConfiguring) throw Error('Unconfirmed voice context'); this.contextApplied = event.revision; this.contextConfiguring = null; this.configured = true; this.audio?.pauseInput(this.muted.input || !this.inputAdmitted); }
      this.deps.emit({ type: 'context-status', revision: event.revision, status: event.status as 'pending' | 'configuring' | 'applied' }); return;
    }
    if (event.type === 'configuring') { if (!exact(event, ['type','epoch'])) throw Error('Invalid voice configuration'); this.configured = false; this.audio?.pauseInput(true); return; }
    if (event.type === 'pong') { if (!exact(event, ['type','epoch'])) throw Error('Invalid voice ping'); return; }
    if (event.type === 'ended') { if (!exact(event, ['type','epoch','complete']) || typeof event.complete !== 'boolean') throw Error('Invalid voice end'); this.stop(); this.deps.emit({ type: 'status', status: 'stopped', phase: 'cleanup', code: 'VOICE_BALANCE_STOPPED' }); void this.replay().catch(() => {}); return; }
    throw Error('Voice returned an unsupported event');
  }
  private receivePCM(buffer: ArrayBuffer) {
    const meta = this.metadata; this.metadata = null;
    if (!meta || buffer.byteLength !== 24 + (meta.samples as number) * 2) throw Error('Invalid voice PCM size');
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    if (bytes[0] !== 89 || bytes[1] !== 86 || bytes[2] !== 49 || bytes[3] !== 2 || view.getUint32(4) !== meta.epoch || view.getUint32(8) !== meta.playbackEpoch || view.getUint32(12) !== meta.sequence || view.getUint32(16) !== meta.part || view.getUint32(20) !== meta.offset) throw Error('Invalid voice PCM counter');
    this.outputSequence++;
    if ((meta.playbackEpoch as number) <= this.suppressedEpoch) return;
    if (this.muted.output) { this.suppressedEpoch = meta.playbackEpoch as number; this.playbackEpoch = meta.playbackEpoch as number; this.control('playback', { playbackEpoch: this.playbackEpoch, playedSamples: 0 }); this.control('interrupt'); return; }
    if ((meta.playbackEpoch as number) < this.playbackEpoch) throw Error('Stale voice PCM');
    if ((meta.playbackEpoch as number) > this.playbackEpoch) {
      this.audio?.flush(); this.playbackEpoch = meta.playbackEpoch as number; this.responseId = null; this.outputPart = -1; this.outputOffset = this.outputReceived = this.played = 0;
    }
    if (this.responseId === null) this.responseId = meta.responseId as string;
    if (meta.responseId !== this.responseId) throw Error('Changed voice response');
    if (meta.part !== this.outputPart) {
      if (meta.part !== this.outputPart + 1 || meta.offset !== 0) throw Error('Voice audio part has a gap');
      this.outputPart = meta.part as number; this.outputOffset = 0;
    }
    if (meta.offset !== this.outputOffset || !this.audio || this.audio.pendingSamples + (meta.samples as number) > 48000) throw Error('Voice audio queue has a gap or overflow');
    if (!this.audio.pendingSamples) this.lastProgress = this.now();
    this.audio.enqueue(bytes.subarray(24), this.playbackEpoch); this.outputOffset += meta.samples as number; this.outputReceived += meta.samples as number;
    this.deps.emit({ type: 'activity', status: 'speaking' });
  }
  private reportPlayback() {
    if (!this.audio) return;
    if (this.suppressedEpoch >= this.playbackEpoch) return;
    const actual = this.audio.playedSamples;
    if (!uint(actual) || actual < this.played || actual > this.outputReceived) throw Error('Invalid voice playback progress');
    if (actual > this.played) this.lastProgress = this.now(); this.played = actual;
    this.control('playback', { playbackEpoch: this.playbackEpoch, playedSamples: this.played });
  }
  private pollAudio() {
    if (this.stopped) return;
    try {
      if (!this.ownsAttempt()) { this.stop(); return; }
      if (this.audio?.pendingSamples) { this.reportPlayback(); if (this.now() - this.lastProgress > 3000) throw Error('Voice speaker stalled'); }
      else { if (this.outputReceived > this.played) this.reportPlayback(); else this.control('ping'); this.deps.emit({ type: 'activity', status: this.inputAdmitted ? 'listening' : 'thinking' }); }
      if (this.pendingContext !== null && this.configured && this.now() - this.lastContextSent >= 500) {
        const context = this.pendingContext;
        const revision = this.control('context', { context });
        if (revision !== undefined) { this.contextRequest = revision; this.pendingContext = null; this.lastContextSent = this.now(); }
      }
    } catch { this.failure(); }
  }
  interrupt(): void {
    if (this.stopped) return;
    if (this.suppressedEpoch >= this.playbackEpoch) return;
    try {
      const actual = this.audio?.playedSamples ?? this.played;
      if (!uint(actual) || actual < this.played || actual > this.outputReceived) throw Error('Invalid voice playback progress');
      this.audio?.flush(); this.suppressedEpoch = this.playbackEpoch; this.played = actual;
      this.control('playback', { playbackEpoch: this.playbackEpoch, playedSamples: actual }); this.control('interrupt');
    }
    catch { this.failure(); }
  }
  setMuted(value: { input: boolean; output: boolean }) {
    if (value.output && !this.muted.output) this.interrupt();
    this.muted = { ...value }; this.applyMute();
  }
  private applyMute() {
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted.input; });
    this.audio?.pauseInput(this.muted.input || !this.configured || !this.inputAdmitted); this.audio?.setMuted(this.muted.output);
    try { this.control('mute', { muted: this.muted.input }); } catch { this.failure(); }
  }
  setSpatial(pose: VoicePose) { this.audio?.setSpatial(pose); }
  updateContext(context: string) {
    if (!this.recipe || !validBalanceRecipe({ ...this.recipe, context })) throw Error('Voice context exceeds the character or UTF-8 budget');
    this.pendingContext = context;
  }
  stop(): void {
    if (this.stopped) return;
    const actual = this.audio?.playedSamples ?? this.played;
    // Silence capture immediately, before any queued network/control work.
    this.audio?.pauseInput(true); this.audio?.setMuted(true);
    for (const track of this.stream?.getTracks() ?? []) { track.onended = null; track.enabled = false; track.stop(); } this.stream = null;
    this.audio?.close(); this.audio = null;
    try {
      if (this.outputReceived && this.suppressedEpoch < this.playbackEpoch && uint(actual) && actual >= this.played && actual <= this.outputReceived) this.control('playback', { playbackEpoch: this.playbackEpoch, playedSamples: actual });
      this.control('finish');
    } catch { /* HTTP exact-call cleanup still follows. */ }
    this.stopped = true; this.configured = false; this.pendingContext = null;
    if (this.timer !== undefined) (this.deps.untick ?? clearInterval)(this.timer); this.timer = undefined;
    if (this.socket) { this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null; this.socket.close(); this.socket = null; }
    this.abort.abort(); this.readyReject?.(Error('Voice stopped')); this.readyReject = undefined;
    this.deps.emit({ type: 'level', value: 0 }); this.deps.emit({ type: 'input-level', value: 0 });
    if (this.receipt && this.current()) void this.request(`${this.base()}/${encodeURIComponent(this.receipt.callId)}/stop`, 'POST').then(raw => this.accept(parseBalanceReceipt(raw))).catch(() => {});
    else if (this.recipe && this.current() && this.deps.currentAttempt()) void this.request(`${this.base()}/recover/finish`, 'POST').then(raw => this.accept(parseBalanceReceipt(raw))).catch(() => {});
  }
  private failure(code = 'VOICE_BALANCE_RECOVERY', reason?: Extract<VoiceEvent, { type: 'status' }>['reason']) {
    if (this.stopped) return; this.stop();
    if (this.current()) this.deps.emit({ type: 'status', status: 'error', code, ...(reason ? { reason } : {}), message: 'Voice disconnected. Retry cleanup or continue in text.', phase: 'cleanup' });
  }
  finish(): Promise<VoiceFinishResult> {
    this.stop();
    // An emission is not a subscriber/save acknowledgment. Each invocation
    // re-delivers the retained journal from zero with the same stable IDs.
    const drain: Drain = { cursor: 0 };
    return (async () => {
      if (!this.current() || !this.deps.currentAttempt()) throw Error('Voice scope is unavailable');
      // Existing in-memory identity permits cleanup after revocation. Fresh
      // pages use the server's atomic exact-attempt cancellation, never absence.
      const path = this.receipt ? `${this.base()}/${encodeURIComponent(this.receipt.callId)}/finish` : `${this.base()}/recover/finish`;
      const value = parseBalanceReceipt(await this.request(path, 'POST')); this.accept(value, drain);
      // One bounded same-call status retry lets a close completed during the
      // POST settle. A still-open journal stays pending; callers may retry.
      const drained = value.status === 'pending' || value.finalSeq !== undefined && drain.cursor !== value.finalSeq ? await this.replay(false, true, drain) : value;
      if (!drained) throw Error('Voice journal is unavailable');
      const result = this.toFinish(drained, drain.cursor);
      if (!isVoiceFinishResult(result)) throw Error('Voice returned an invalid cleanup result');
      return result;
    })();
  }
  private toFinish(value: Receipt, cursor: number) {
    this.checkReceipt(value);
    if (value.finalSeq !== undefined && (cursor !== value.finalSeq || this.observedFinalSeq > cursor)) throw Error('Voice final groups are not fully delivered');
    const result = { status: value.status, callId: value.callId, connectionId: value.connectionId, epoch: value.epoch, attempt: { ...value.attempt }, providerState: value.providerState, accounting: value.accountingState };
    return { ...result, ...(['finished','incomplete'].includes(value.status) && value.finalSeq !== undefined ? { lastFinalSeq: value.finalSeq } : {}) } as VoiceFinishResult;
  }
  dispose(): void { this.stop(); this.disposed = true; this.cleanupAbort.abort(); this.delivered.clear(); this.groups.clear(); this.receipt = null; }
}
