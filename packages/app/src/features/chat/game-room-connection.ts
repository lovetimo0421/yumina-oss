import { holdReload } from "@/lib/reload-safety";
import { getGameIdentityClient, type GuestIdentity } from "@/lib/game-identity";

const INPUT_MIN_INTERVAL_MS = 90;
type CommandResult = { ok: boolean; body?: unknown };
export interface JoinResult {
  ok: boolean;
  seatId?: string;
  roomId?: string;
  tick?: number;
  snap?: unknown;
  reason?: string;
}
interface ConnectionOptions {
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
  guest?: () => Promise<GuestIdentity | null>;
  apiBase?: string;
  joinTimeoutMs?: number;
}

/** Parent-owned transport. Credentials and sockets never enter creator code. */
export class GameRoomConnection {
  private ws: WebSocket | null = null;
  private epoch = 0;
  private cancelJoin: (() => void) | null = null;
  private cmdCounter = 0;
  private pendingCmds = new Map<string, { resolve: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private inputSeq = 0;
  private lastInputAt = 0;
  private pendingInput: Record<string, unknown> | null = null;
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseReloadHold: (() => void) | null = null;

  constructor(private onFrame: (frame: Record<string, unknown>) => void, private options: ConnectionOptions = {}) {}

  /** One bounded, cancellable attempt; a stale attempt cannot replace a new socket. */
  join(roomId: string): Promise<JoinResult> {
    this.destroy();
    const epoch = this.epoch;
    this.releaseReloadHold = holdReload("game-room");
    const controller = new AbortController();
    const fetcher = this.options.fetch ?? fetch;
    const apiBase = this.options.apiBase ?? import.meta.env?.VITE_API_URL ?? "";
    return new Promise(resolve => {
      let settled = false;
      const settle = (result: JoinResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (epoch === this.epoch) this.cancelJoin = null;
        resolve(result);
      };
      const fail = (reason: string) => {
        settle({ ok: false, reason });
        controller.abort();
        if (epoch === this.epoch) this.cleanup(reason);
      };
      const timeout = setTimeout(() => fail("timeout"), this.options.joinTimeoutMs ?? 15_000);
      this.cancelJoin = () => fail("cancelled");
      const alive = () => epoch === this.epoch && !controller.signal.aborted;
      const request = (path: string, body: unknown) => fetcher(`${apiBase}/api/game/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body), signal: controller.signal,
      });
      void (async () => {
        try {
          let response = await request("ticket", { roomId });
          if (!alive()) return;
          if (response.status === 401) {
            const guest = await (this.options.guest ? this.options.guest() : getGameIdentityClient().then(c => c?.markGuestVisit() ?? null));
            if (!alive()) return;
            response = await request("guest-ticket", { roomId, guestToken: guest?.guestToken });
          }
          if (!alive()) return;
          if (!response.ok) {
            fail(response.status === 503 ? "unavailable" : response.status === 429 ? "rate-limited" : `ticket-${response.status}`);
            return;
          }
          const data = await response.json() as { ticket: string; url: string };
          if (!alive()) return;
          if (!data.ticket || typeof data.ticket !== "string" || typeof data.url !== "string" || !/^wss?:\/\//.test(data.url)) {
            fail("bad-assignment"); return;
          }
          let ws: WebSocket;
          try { ws = this.options.socket ? this.options.socket(data.url) : new WebSocket(data.url); }
          catch { fail("bad-url"); return; }
          this.ws = ws;
          ws.onopen = () => { if (alive()) { try { ws.send(JSON.stringify({ t: "hello", ticket: data.ticket })); } catch { fail("closed"); } } };
          ws.onmessage = ev => {
            if (!alive()) return;
            let frame: Record<string, unknown>;
            try {
              const parsed = JSON.parse(String(ev.data));
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
              frame = parsed;
            } catch { return; }
            if (!settled && frame.t === "welcome") {
              settle({ ok: true, seatId: frame.seatId as string, roomId: frame.roomId as string, tick: frame.tick as number, snap: frame.snap });
              this.onFrame({ t: "status", state: "open" }); return;
            }
            if (frame.t === "reject") { fail(typeof frame.reason === "string" ? frame.reason : "rejected"); return; }
            if (frame.t === "ack") {
              const pending = this.pendingCmds.get(frame.id as string);
              if (pending) { clearTimeout(pending.timer); this.pendingCmds.delete(frame.id as string); pending.resolve({ ok: frame.ok === true, body: frame.body }); }
              return;
            }
            this.onFrame(frame);
          };
          ws.onclose = () => {
            if (!alive()) return;
            settle({ ok: false, reason: "closed" });
            controller.abort();
            this.cleanup("closed");
            this.onFrame({ t: "status", state: "closed" });
          };
          ws.onerror = () => { /* Browser emits close next; the attempt deadline also bounds this. */ };
        } catch { if (alive()) fail("network"); }
      })();
    });
  }

  sendInput(body: Record<string, unknown>): void {
    if (this.ws?.readyState !== 1) return;
    this.pendingInput = { ...this.pendingInput, ...body };
    const dueIn = this.lastInputAt + INPUT_MIN_INTERVAL_MS - Date.now();
    if (dueIn <= 0) this.flushInput();
    else if (!this.inputTimer) this.inputTimer = setTimeout(() => this.flushInput(), dueIn);
  }
  private flushInput(): void {
    if (this.inputTimer) { clearTimeout(this.inputTimer); this.inputTimer = null; }
    if (!this.pendingInput || this.ws?.readyState !== 1) return;
    this.lastInputAt = Date.now();
    try { this.ws.send(JSON.stringify({ t: "input", seq: ++this.inputSeq, body: this.pendingInput })); } catch { /* close handles transport failure */ }
    this.pendingInput = null;
  }
  sendCommand(name: string, body?: unknown): Promise<CommandResult> {
    if (this.ws?.readyState !== 1) return Promise.resolve({ ok: false, body: { reason: "not-connected" } });
    if (this.pendingCmds.size >= 64) return Promise.resolve({ ok: false, body: { reason: "busy" } });
    const id = `c${++this.cmdCounter}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(id); resolve({ ok: false, body: { reason: "timeout" } });
      }, 10_000);
      this.pendingCmds.set(id, { resolve, timer });
      try { this.ws!.send(JSON.stringify({ t: "cmd", id, name, body })); }
      catch { clearTimeout(timer); this.pendingCmds.delete(id); resolve({ ok: false, body: { reason: "closed" } }); }
    });
  }
  private cleanup(reason: string): void {
    this.releaseReloadHold?.(); this.releaseReloadHold = null;
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.inputTimer = null; this.pendingInput = null;
    for (const pending of this.pendingCmds.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, body: { reason } }); }
    this.pendingCmds.clear();
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onclose = ws.onmessage = ws.onopen = ws.onerror = null; try { ws.close(); } catch { /* already closed */ } }
  }
  destroy(): void {
    this.cancelJoin?.(); this.cancelJoin = null;
    this.epoch++;
    this.cleanup("cancelled");
    this.lastInputAt = 0; this.inputSeq = 0;
  }
}
