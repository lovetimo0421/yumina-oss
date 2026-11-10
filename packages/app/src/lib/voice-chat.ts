/**
 * Table voice — real-time voice between the humans seated in one game room
 * (e.g. the Avalon card), plus "what did I just say" transcripts for the AI
 * players at the table.
 *
 * Why parent-side: the card's sandbox iframe has no microphone permission and
 * no network (connect-src 'none'). Same split as voice input and readout: the
 * card asks over the bridge (`api.room.voice(...)`), this module does the work,
 * and events go back through the room-frame channel as `{t:"voice", kind, ...}`.
 *
 * Wire format (game-server `/voice`, see packages/game-server/src/voice-relay.ts):
 * 16 kHz mono, 20 ms frames, G.711 µ-law — 320 bytes/frame, ~128 kbps while
 * the mic is open. Deliberately codec-free so it plays everywhere WebAudio does
 * (no WebCodecs / MediaSource dependency); the mic is push-to-toggle, so the
 * bandwidth is only spent while someone is talking.
 *
 * Transcripts: while the mic is open a small energy VAD cuts utterances
 * (700 ms of silence ends one); each is posted to /api/voice-input as WAV with
 * the card's vocabulary hint, and the text comes back as kind:"transcript".
 */
import { getGameIdentityClient } from "@/lib/game-identity";
import { useAudioStore } from "@/stores/audio";

const RATE = 16_000;
const FRAME = 320; // 20 ms
const PLAY_LEAD = 0.06; // first frame plays this far ahead (jitter cushion)
const MAX_LAG = 0.45; // more queued than this → drop the backlog, stay live
const VAD_MIN = 0.012; // 绝对下限
const VAD_FLOOR_X = 2.6; // 说话 = 比房间底噪高这么多倍
const VAD_SILENCE_MS = 700;
const MIN_UTTERANCE_MS = 450;
const MAX_UTTERANCE_MS = 15_000;

const apiBase = import.meta.env?.VITE_API_URL ?? "";

export type VoiceChatEmit = (frame: Record<string, unknown>) => void;

// ── G.711 µ-law ──
function muEncode(sample: number): number {
  let s = Math.max(-1, Math.min(1, sample)) * 32767;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  s = Math.min(s + 132, 32635);
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
const MU_TABLE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exp = (u >> 4) & 0x07;
    const mant = u & 0x0f;
    let s = ((mant << 3) + 132) << exp;
    s -= 132;
    t[i] = (sign ? -s : s) / 32768;
  }
  return t;
})();

function wavBlob(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 32767, true);
  return new Blob([buf], { type: "audio/wav" });
}

export class VoiceChat {
  private ws: WebSocket | null = null;
  private roomId: string | null = null;
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private stream: MediaStream | null = null;
  private proc: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private micOn = false;
  private listenOn = true;
  private pending = new Float32Array(0);
  private resamplePos = 0;
  private peers = new Map<string, { next: number }>();
  private hint = "";
  private destroyed = false;
  private retry = 0;
  // VAD / transcript
  private utter: Float32Array[] = [];
  private utterMs = 0;
  private silenceMs = 0;
  private speaking = false;
  private noiseFloor = 0.006; // 房间底噪(没说话时缓慢跟踪)

  constructor(private emit: VoiceChatEmit) {}

  setHint(text: string) {
    this.hint = String(text || "").slice(0, 400);
  }

  private async audio(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.out = this.ctx.createGain();
      this.out.gain.value = this.listenOn ? 1 : 0;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // ── 连接语音房间(和游戏房间同一个 roomId,要先在 /ws 里入座)──
  async join(roomId: string): Promise<{ ok: boolean; reason?: string }> {
    this.roomId = roomId;
    this.destroyed = false;
    await this.audio();
    return this.connect();
  }

  private async connect(): Promise<{ ok: boolean; reason?: string }> {
    const roomId = this.roomId;
    if (!roomId || this.destroyed) return { ok: false, reason: "no-room" };
    const req = (path: string, body: unknown) => fetch(`${apiBase}/api/game/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
    let res: Response;
    try {
      res = await req("ticket", { roomId });
      if (res.status === 401) {
        const guest = await getGameIdentityClient().then((c) => c?.markGuestVisit() ?? null);
        res = await req("guest-ticket", { roomId, guestToken: guest?.guestToken });
      }
    } catch {
      return { ok: false, reason: "network" };
    }
    if (!res.ok) return { ok: false, reason: `ticket-${res.status}` };
    const data = (await res.json()) as { ticket?: string; url?: string };
    if (!data.ticket || !data.url || !/^wss?:\/\//.test(data.url)) return { ok: false, reason: "bad-assignment" };
    const url = data.url.replace(/\/ws(\?.*)?$/, "/voice");
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { ok: boolean; reason?: string }) => { if (!settled) { settled = true; resolve(r); } };
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws?.close();
      this.ws = ws;
      const timer = setTimeout(() => { done({ ok: false, reason: "timeout" }); ws.close(); }, 12_000);
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", ticket: data.ticket }));
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return this.receive(ev.data as ArrayBuffer);
        let m: Record<string, unknown>;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === "welcome") {
          clearTimeout(timer);
          this.retry = 0;
          if (this.micOn) ws.send(JSON.stringify({ t: "talk", on: true }));
          this.emit({ t: "voice", kind: "joined", peers: m.peers });
          done({ ok: true });
        } else if (m.t === "reject") {
          clearTimeout(timer);
          done({ ok: false, reason: String(m.reason) });
        } else if (m.t === "join" || m.t === "leave" || m.t === "talk") {
          if (m.t === "leave") this.peers.delete(String(m.userId));
          this.emit({ t: "voice", kind: m.t, userId: m.userId, name: m.name, on: m.on });
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        done({ ok: false, reason: "closed" });
        if (this.ws !== ws || this.destroyed) return;
        this.ws = null;
        this.emit({ t: "voice", kind: "disconnected" });
        // 断了就悄悄重连:语音是在游戏房间旁边的,游戏连着它就该连着
        const delay = Math.min(10_000, 1000 * 2 ** this.retry++);
        setTimeout(() => { if (!this.destroyed && this.roomId) void this.connect(); }, delay);
      };
    });
  }

  // ── 收:[idLen][userId][µ-law] → 排进这个人的播放时间线 ──
  private receive(buf: ArrayBuffer) {
    if (!this.listenOn || !this.ctx || !this.out) return;
    const bytes = new Uint8Array(buf);
    const idLen = bytes[0] ?? 0;
    const userId = new TextDecoder().decode(bytes.subarray(1, 1 + idLen));
    const payload = bytes.subarray(1 + idLen);
    if (!payload.length) return;
    const pcm = new Float32Array(payload.length);
    for (let i = 0; i < payload.length; i++) pcm[i] = MU_TABLE[payload[i]!]!;
    const ab = this.ctx.createBuffer(1, pcm.length, RATE);
    ab.copyToChannel(pcm, 0);
    const node = this.ctx.createBufferSource();
    node.buffer = ab;
    node.connect(this.out);
    const now = this.ctx.currentTime;
    const peer = this.peers.get(userId) ?? { next: 0 };
    let at = Math.max(peer.next, now + PLAY_LEAD);
    if (at - now > MAX_LAG) at = now + PLAY_LEAD; // 积压了就跳到现在,宁可丢一点也不越拖越久
    node.start(at);
    peer.next = at + ab.duration;
    this.peers.set(userId, peer);
  }

  // ── 说:开麦/闭麦(按键开关)──
  async setMic(on: boolean): Promise<{ ok: boolean; reason?: string }> {
    if (on === this.micOn) return { ok: true };
    if (on) {
      const ctx = await this.audio();
      if (!this.stream) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        } catch {
          return { ok: false, reason: "denied" };
        }
        this.source = ctx.createMediaStreamSource(this.stream);
        this.proc = ctx.createScriptProcessor(2048, 1, 1);
        const sink = ctx.createGain();
        sink.gain.value = 0; // 处理节点要接到输出才会跑,但别把自己的声音放出来
        this.source.connect(this.proc);
        this.proc.connect(sink);
        sink.connect(ctx.destination);
        this.proc.onaudioprocess = (e) => this.capture(e.inputBuffer.getChannelData(0), ctx.sampleRate);
      }
      this.micOn = true;
    } else {
      this.micOn = false;
      this.endUtterance();
    }
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ t: "talk", on: this.micOn }));
    this.emit({ t: "voice", kind: "mic", on: this.micOn });
    return { ok: true };
  }

  // ── 听:开/关别人的声音 ──
  setListen(on: boolean) {
    this.listenOn = on;
    if (this.out) this.out.gain.value = on ? 1 : 0;
    if (!on) this.peers.clear();
    this.emit({ t: "voice", kind: "listen", on });
  }

  private capture(input: Float32Array, srcRate: number) {
    if (!this.micOn) return;
    // 线性重采样到 16k
    const ratio = srcRate / RATE;
    const outLen = Math.floor((input.length - this.resamplePos) / ratio);
    const resampled = new Float32Array(Math.max(0, outLen));
    let pos = this.resamplePos;
    for (let i = 0; i < resampled.length; i++, pos += ratio) {
      const k = Math.floor(pos);
      const f = pos - k;
      resampled[i] = (input[k] ?? 0) * (1 - f) + (input[k + 1] ?? input[k] ?? 0) * f;
    }
    this.resamplePos = pos - input.length;
    const merged = new Float32Array(this.pending.length + resampled.length);
    merged.set(this.pending);
    merged.set(resampled, this.pending.length);
    let off = 0;
    for (; off + FRAME <= merged.length; off += FRAME) this.frame(merged.subarray(off, off + FRAME));
    this.pending = merged.slice(off);
  }

  private frame(pcm: Float32Array) {
    if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 64 * 1024) {
      const enc = new Uint8Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) enc[i] = muEncode(pcm[i]!);
      this.ws.send(enc);
    }
    // VAD:能量门限;AI 正在朗读时门限抬高,别把喇叭里的 AI 声音当成你说的话
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
    const rms = Math.sqrt(sum / pcm.length);
    // 门限跟着房间底噪走;AI 正在朗读时只略微抬一点(靠浏览器回声消除挡掉喇叭声),
    // 以前抬 3 倍,结果 AI 一直在说,真人的话几乎都被当成噪音丢了
    const ttsPlaying = !!useAudioStore.getState().voicePlayback;
    if (!this.speaking) this.noiseFloor = this.noiseFloor * 0.98 + Math.min(rms, 0.05) * 0.02;
    const threshold = Math.max(VAD_MIN, this.noiseFloor * VAD_FLOOR_X) * (ttsPlaying ? 1.4 : 1);
    const loud = rms > threshold;
    if (loud) {
      if (!this.speaking) {
        this.speaking = true;
        this.emit({ t: "voice", kind: "speaking", on: true });
      }
      this.silenceMs = 0;
    } else if (this.speaking) this.silenceMs += 20;
    if (this.speaking) {
      this.utter.push(pcm.slice());
      this.utterMs += 20;
      if (this.silenceMs >= VAD_SILENCE_MS || this.utterMs >= MAX_UTTERANCE_MS) this.endUtterance();
    }
  }

  private endUtterance() {
    if (!this.speaking) return;
    this.speaking = false;
    this.emit({ t: "voice", kind: "speaking", on: false });
    const voicedMs = this.utterMs - this.silenceMs;
    if (voicedMs >= MIN_UTTERANCE_MS) this.emit({ t: "voice", kind: "transcribing" });
    const parts = this.utter;
    this.utter = [];
    this.utterMs = 0;
    this.silenceMs = 0;
    if (voicedMs < MIN_UTTERANCE_MS) return;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    void this.transcribe(all);
  }

  private async transcribe(samples: Float32Array) {
    const form = new FormData();
    form.append("file", wavBlob(samples), "utterance.wav");
    form.append("lang", "zh");
    if (this.hint) form.append("prompt", this.hint);
    try {
      const res = await fetch(`${apiBase}/api/voice-input`, { method: "POST", credentials: "include", body: form });
      if (!res.ok) return this.emit({ t: "voice", kind: "transcript-error", status: res.status });
      const data = (await res.json()) as { text?: string };
      const text = (data.text || "").trim();
      if (text) this.emit({ t: "voice", kind: "transcript", text });
    } catch {
      this.emit({ t: "voice", kind: "transcript-error", status: 0 });
    }
  }

  leave() {
    this.destroyed = true;
    this.roomId = null;
    this.micOn = false;
    this.ws?.close();
    this.ws = null;
    this.peers.clear();
  }

  destroy() {
    this.leave();
    this.proc?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.proc = null;
    this.source = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.out = null;
  }
}
