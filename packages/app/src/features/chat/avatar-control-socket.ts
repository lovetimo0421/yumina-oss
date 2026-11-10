/** Reconnect only the control socket of an already-owned avatar session.
 * Already submitted packets are never replayed. Unsent packets have a short,
 * bounded queue; no new paid session or conversation is created here. */
export class AvatarControlSocket {
  private socket?: WebSocket;
  private closed = false;
  private ready = false;
  private established = false;
  private attempts = 0;
  private pending: string[] = [];
  private bytes = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private stalled?: ReturnType<typeof setTimeout>;
  private code = 1006;
  constructor(private url: string, private deps: {
    create(url: string): WebSocket; ready(): void;
    event(event: Record<string, unknown>): void; fail(message: string): void; canRecover?(): boolean; recovering?(): void;
  }, private timing = { retryMs: 500, recoveryMs: 6000 }) {}
  start() {
    if (this.closed) return;
    let socket: WebSocket;
    try { socket = this.deps.create(this.url); } catch { this.recover(); return; }
    this.socket = socket;
    const current = () => !this.closed && this.socket === socket;
    socket.onmessage = ({ data }) => {
      if (!current() || typeof data !== 'string' || data.length > 64 * 1024) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(data); } catch { this.fail('Avatar sent an invalid response. Reconnect to continue.'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { this.fail('Avatar sent an invalid response. Reconnect to continue.'); return; }
      if (event.type === 'session.state_updated') {
        if (event.state === 'connected') {
          this.ready = true; this.established = true;
          clearTimeout(this.deadline); this.deadline = undefined;
          // Drain in original order before accepting new speech.
          this.drain();
          if (this.closed) return;
          this.deps.ready();
        } else if (event.state === 'disconnected') this.recover();
        else if (event.state === 'closing' || event.state === 'closed') this.fail('The avatar provider ended the session. Reconnect to continue.');
      } else if (event.type === 'error') this.fail('Avatar playback failed. Reconnect to continue.');
      else this.deps.event(event);
    };
    socket.onclose = event => { if (current()) { this.code = Number.isInteger(event?.code) ? event.code : 1006; this.recover(); } };
    socket.onerror = () => { if (current()) this.recover(); };
  }
  send(event: Record<string, unknown>) {
    this.enqueue(event, false);
  }
  /** Let an upstream bounded queue retain packets while this queue drains. */
  trySend(event: Record<string, unknown>): boolean {
    return this.enqueue(event, true);
  }
  private enqueue(event: Record<string, unknown>, deferOnFull: boolean): boolean {
    if (this.closed) return false;
    if (event.type === 'agent.interrupt') { this.pending = []; this.bytes = 0; }
    if (!this.ready && event.type === 'session.keep_alive') return true;
    const packet = JSON.stringify(event);
    // No utterance can legitimately precede initial session readiness.
    if (!this.established) { this.fail('Avatar audio connection is not ready. Reconnect to continue.'); return false; }
    if (this.bytes + packet.length > 512 * 1024 || this.pending.length >= 128) {
      if (!deferOnFull) this.fail('Avatar audio recovery exceeded its buffer. Reconnect to continue.');
      return false;
    }
    this.bytes += packet.length;
    this.pending.push(packet);
    this.drain();
    return !this.closed;
  }
  private drain() {
    if (this.closed || !this.ready || this.socket?.readyState !== 1) return;
    while (this.pending.length) {
      if (this.socket.bufferedAmount > 256 * 1024) {
        if (!this.stalled) this.stalled = setTimeout(() => this.fail('Avatar audio connection stalled. Reconnect to continue.'), 6000);
        if (!this.drainTimer) this.drainTimer = setTimeout(() => { this.drainTimer = undefined; this.drain(); }, 25);
        return;
      }
      const packet = this.pending[0];
      try { this.socket.send(packet); }
      catch { this.fail('Avatar audio connection failed. Reconnect to continue.'); return; }
      this.pending.shift(); this.bytes -= packet.length;
    }
    clearTimeout(this.stalled); this.stalled = undefined;
  }
  private detach() {
    const socket = this.socket; this.socket = undefined;
    if (socket) { socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); }
  }
  private recover() {
    if (this.closed || this.retry) return;
    this.ready = false; this.detach();
    if (!this.established || this.deps.canRecover?.() === false) { this.fail('Avatar connection failed. Start voice again.'); return; }
    if (this.attempts >= 2) { this.fail(`Avatar connection lost (socket ${this.code}). Reconnect to continue.`); return; }
    this.deps.recovering?.();
    if (!this.deadline) this.deadline = setTimeout(() => this.fail(`Avatar could not reconnect (socket ${this.code}). Reconnect to continue.`), this.timing.recoveryMs);
    this.attempts++;
    this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, this.timing.retryMs);
  }
  private fail(message: string) { if (!this.closed) { this.close(); this.deps.fail(message); } }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.retry); clearTimeout(this.deadline);
    clearTimeout(this.drainTimer); clearTimeout(this.stalled);
    this.pending = []; this.bytes = 0; this.detach();
  }
}
