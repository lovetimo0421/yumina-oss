export type AvatarPlayback = "started" | "stopped" | "cleared";
interface UtteranceCallbacks {
  uuid(): string;
  send(event: Record<string, unknown>): void;
  capture(event: Record<string, unknown>): void;
  playback(event: AvatarPlayback): void;
  mute(value: boolean): void;
  error?(message: string): void;
  now?(): number;
  pending?(): void;
  queue?(count: number): void;
}
interface Utterance {
  id: string;
  epoch: number;
  responseId?: string;
  sent: boolean;
  sealed: boolean;
  draining: boolean;
  ended: boolean;
  bytes: number;
  deadline: number;
}

/** The OpenAI RTP clock and LiveAvatar playback clock are independent. Only
 * correlated LiveAvatar events may open the audible output gate. */
export class AvatarUtterances {
  private live = false;
  private closed = false;
  private epoch = 0;
  private capturing?: Utterance;
  private latestResponseId?: string;
  private latestAcceptedResponseId?: string;
  private playbackId?: string;
  private latestPlaybackEpoch = 0;
  private muted = false;
  private utterances = new Map<number, Utterance>();
  private discardedResponses = new Set<string>();
  private acceptedResponses = new Set<string>();
  constructor(private callbacks: UtteranceCallbacks) { callbacks.mute(true); }
  private now() { return this.callbacks.now?.() ?? Date.now(); }
  connected() { if (!this.closed) this.live = true; }
  keepAlive() {
    if (this.live && !this.closed) this.callbacks.send({ type: "session.keep_alive", event_id: this.callbacks.uuid() });
  }
  provider(event: Record<string, unknown>): boolean {
    const type = event.type;
    const outputEvent = typeof type === "string" && type.startsWith("output_audio_buffer.");
    if (this.closed) return outputEvent;
    if (type === "response.created") {
      const response = event.response as { id?: unknown } | undefined;
      if (typeof response?.id === "string") this.latestResponseId = response.id;
    }
    if (!outputEvent) return false;
    const responseId = typeof event.response_id === "string" ? event.response_id : this.latestResponseId;
    if (!this.live || (responseId && this.discardedResponses.has(responseId))) return true;
    if (type === "output_audio_buffer.started") {
      if (responseId && this.acceptedResponses.has(responseId)) return true;
      if (this.capturing && this.capturing.responseId === responseId) return true;
      if (responseId) this.acceptedResponses.add(responseId);
      this.latestAcceptedResponseId = responseId;
      while (this.acceptedResponses.size > 128) this.acceptedResponses.delete(this.acceptedResponses.values().next().value!);
      const utterance: Utterance = { id: this.callbacks.uuid(), epoch: ++this.epoch, responseId,
        sent: false, sealed: false, draining: false, ended: false, bytes: 0, deadline: this.now() + 30_000 };
      this.capturing = utterance;
      this.utterances.set(utterance.epoch, utterance);
      this.callbacks.queue?.(this.utterances.size);
      this.callbacks.pending?.();
      // The worklet flushes an earlier draining epoch before opening this one.
      this.callbacks.capture({ type: "begin", epoch: utterance.epoch });
    } else if (type === "output_audio_buffer.stopped") {
      const current = this.capturing;
      if (current && !current.draining && (!responseId || current.responseId === responseId)) {
        current.draining = true;
        this.callbacks.capture({ type: "drain", epoch: current.epoch, frames: 4800 });
      }
    } else if (type === "output_audio_buffer.cleared") {
      // A clear for an old response can arrive after a new response has started.
      if (!responseId || this.latestAcceptedResponseId === responseId) this.interrupt(responseId);
    }
    return true;
  }
  client(event: Record<string, unknown>) {
    if (event.type === "output_audio_buffer.clear") this.interrupt();
    if (event.type === "response.cancel") {
      const target = typeof event.response_id === "string" ? event.response_id : undefined;
      if (target) {
        this.discardedResponses.add(target);
        while (this.discardedResponses.size > 128) this.discardedResponses.delete(this.discardedResponses.values().next().value!);
        if (this.latestAcceptedResponseId !== target) return;
      }
      this.interrupt(target);
    }
  }
  private interrupt(target?: string) {
    if (this.closed) return;
    const hadPending = this.utterances.size > 0;
    for (const utterance of this.utterances.values()) {
      if (utterance.responseId) this.discardedResponses.add(utterance.responseId);
    }
    if (this.latestResponseId && (!target || this.latestResponseId === target)) this.discardedResponses.add(this.latestResponseId);
    // Session duration is bounded, but so is this set under abusive input.
    while (this.discardedResponses.size > 128) this.discardedResponses.delete(this.discardedResponses.values().next().value!);
    this.capturing = undefined; this.playbackId = undefined; this.utterances.clear();
    this.callbacks.queue?.(0);
    this.callbacks.mute(true);
    this.callbacks.capture({ type: "clear", epoch: ++this.epoch });
    if (hadPending) {
      this.callbacks.playback("cleared");
      if (this.live) this.callbacks.send({ type: "agent.interrupt", event_id: this.callbacks.uuid() });
    }
  }
  pcm(epoch: number, data: Uint8Array) {
    const utterance = this.utterances.get(epoch);
    if (this.closed || !this.live || !utterance || utterance.sealed || !data.byteLength) return;
    utterance.sent = true; utterance.ended = false; utterance.bytes += data.byteLength;
    if (utterance.id === this.playbackId) utterance.deadline = this.now() + 30_000 + utterance.bytes / 48;
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    this.callbacks.send({ type: "agent.speak", event_id: utterance.id, audio: btoa(binary) });
  }
  drained(epoch: number) {
    const utterance = this.utterances.get(epoch);
    if (this.closed || !utterance || utterance.sealed) return;
    utterance.sealed = true;
    if (this.capturing === utterance) this.capturing = undefined;
    if (utterance.sent) {
      this.callbacks.send({ type: "agent.speak_end", event_id: utterance.id });
      if (utterance.ended) {
        this.utterances.delete(epoch);
        this.callbacks.queue?.(this.utterances.size);
        if (this.latestPlaybackEpoch === epoch) this.callbacks.playback("stopped");
      }
    }
    else { this.utterances.delete(epoch); this.callbacks.queue?.(this.utterances.size); this.callbacks.playback("cleared"); }
  }
  avatar(event: Record<string, unknown>) {
    if (this.closed || typeof event.source_event_id !== "string") return;
    const utterance = [...this.utterances.values()].find(u => u.id === event.source_event_id);
    if (!utterance || !utterance.sent) return;
    if (event.type === "agent.speak_started") {
      if (utterance.epoch < this.latestPlaybackEpoch || this.playbackId === utterance.id) return;
      this.latestPlaybackEpoch = utterance.epoch; this.playbackId = utterance.id;
      utterance.ended = false;
      utterance.deadline = this.now() + 30_000 + utterance.bytes / 48;
      this.callbacks.mute(this.muted); this.callbacks.playback("started");
    } else if (event.type === "agent.speak_ended" || event.type === "agent.speak_interrupted") {
      // Streaming playback may end at a chunk gap before OpenAI has drained.
      // Retain that source identity for later PCM and a real server interrupt;
      // notifying the controller here would release queued scene responses.
      const complete = utterance.sealed || event.type === "agent.speak_interrupted";
      utterance.ended = true;
      if (complete) this.utterances.delete(utterance.epoch);
      if (complete) this.callbacks.queue?.(this.utterances.size);
      if (this.playbackId !== utterance.id && !(complete && !this.playbackId && this.latestPlaybackEpoch === utterance.epoch)) return;
      this.playbackId = undefined; this.callbacks.mute(true);
      if (complete) this.callbacks.playback(event.type === "agent.speak_ended" ? "stopped" : "cleared");
    }
    // audio_buffer_cleared names the interrupt command, not an utterance. It
    // never changes local playback; interruption already closed the gate.
  }
  checkTimeout() {
    if (this.closed) return;
    if ([...this.utterances.values()].some(u => u.deadline <= this.now())) {
      this.callbacks.error?.("Avatar playback timed out. Start voice again.");
    }
  }
  setMuted(value: boolean) { this.muted = value; if (!this.closed) this.callbacks.mute(value || !this.playbackId); }
  close() {
    if (this.closed) return;
    this.closed = true; this.live = false; this.utterances.clear();
    this.callbacks.queue?.(0);
    this.capturing = undefined; this.playbackId = undefined;
    this.callbacks.mute(true);
    this.callbacks.capture({ type: "clear", epoch: ++this.epoch });
  }
}
let nextVideoFrameId = 0;
export class AvatarFrameGate {
  private outstanding: number | null = null;
  private closed = false;
  begin(): number | null {
    if (this.closed || this.outstanding !== null) return null;
    this.outstanding = ++nextVideoFrameId; return this.outstanding;
  }
  ack(id: number) { if (Number.isInteger(id) && id === this.outstanding) this.outstanding = null; }
  close() { this.closed = true; this.outstanding = null; }
  static size(width: number, height: number) {
    const scale = Math.min(1, 768 / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }
}
