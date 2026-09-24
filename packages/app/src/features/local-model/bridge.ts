/**
 * The courier half of the local bridge.
 *
 * Yumina's servers can't reach a model on the player's machine — their
 * `localhost` is our container. So this tab does it: it holds an SSE
 * connection open for work, and when a turn arrives it forwards the prompt to
 * the runtime running beside it and streams the tokens back up.
 *
 *   server ──(SSE: job)──► this tab ──(fetch)──► 127.0.0.1 runtime
 *   server ◄──(POST: chunks)── this tab ◄──(stream)──┘
 *
 * Tokens go back in ~120ms batches rather than one request per token: a POST
 * per token would be hundreds of requests for one reply, and nobody can read
 * faster than a batch lands anyway.
 */

import i18n from "@/lib/i18n";
import type { DetectedModel, RuntimeCandidate } from "./detect.js";

const apiBase = import.meta.env?.VITE_API_URL || "";

export type BridgeStatus = "idle" | "connecting" | "connected" | "running" | "error";

/** How often a connected tab checks the runtime is still there between turns. */
const HEARTBEAT_MS = 15_000;

/**
 * What the player reads when their runtime is gone. The raw error is the
 * browser's "Failed to fetch", which says nothing about what to do.
 */
function unreachableMessage(runtime: RuntimeCandidate): string {
  return i18n.t("profile:localModel.unreachable", { runtime: runtime.label });
}

/** Is the runtime answering? Cheap enough to ask every few seconds. */
async function runtimeAlive(runtime: RuntimeCandidate): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const res = await fetch(`${runtime.origin}${runtime.native ? "/api/version" : "/v1/models"}`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface BridgeJob {
  requestId: string;
  payload: {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    max_tokens?: number;
    response_format?: { type: 'json_object' };
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    num_ctx?: number;
    /** Ollama's `think`. The server sends false: see LocalBridgeProvider. */
    think?: boolean;
  };
}

const FLUSH_INTERVAL_MS = 120;

async function report(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${apiBase}/api/local-bridge/report`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // The turn is already lost if we can't report; the server's inactivity
    // timeout will tell the player. Nothing useful to do from here.
  }
}

/** Batches deltas so one reply is a handful of POSTs instead of hundreds. */
class ChunkSink {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Serializes the POSTs. The server appends batches in arrival order, so two
   * requests in flight at once can land swapped and the reply comes out
   * interleaved — "the floorboards groan under." … "thud their own weight."
   * It is a race, so it hides on slow models (one batch finishes before the
   * next is due) and gets steadily worse the faster the model runs. Chaining
   * means batch N+1 is not sent until batch N has landed.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly requestId: string) {}

  push(delta: string): void {
    if (!delta) return;
    this.buffer += delta;
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer) return this.tail;
    const delta = this.buffer;
    this.buffer = "";
    this.tail = this.tail.then(() => report({ kind: "chunk", requestId: this.requestId, delta }));
    return this.tail;
  }
}

interface RunOutcome {
  stopReason?: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Ollama's own endpoint, not its OpenAI-compatible one — only the native API
 * takes `options.num_ctx`, and running at the runtime's default window instead
 * of the one the prompt was budgeted for silently drops the front of the
 * prompt (persona and lorebook first) with no error anywhere.
 */
async function runOllama(origin: string, job: BridgeJob, sink: ChunkSink, signal: AbortSignal): Promise<RunOutcome> {
  const p = job.payload;
  const res = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: p.model,
      messages: p.messages,
      stream: true,
      ...(p.response_format?.type === 'json_object' && { format: 'json' }),
      // Thinking models otherwise reason until the budget runs out and the
      // player sees nothing (runtimes that don't think ignore this).
      think: p.think ?? false,
      options: {
        ...(p.num_ctx !== undefined && { num_ctx: p.num_ctx }),
        ...(p.max_tokens !== undefined && { num_predict: p.max_tokens }),
        ...(p.temperature !== undefined && { temperature: p.temperature }),
        ...(p.top_p !== undefined && { top_p: p.top_p }),
        ...(p.top_k !== undefined && { top_k: p.top_k }),
        ...(p.min_p !== undefined && { min_p: p.min_p }),
        ...(p.frequency_penalty !== undefined && { frequency_penalty: p.frequency_penalty }),
        ...(p.presence_penalty !== undefined && { presence_penalty: p.presence_penalty }),
      },
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const outcome: RunOutcome = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    // Native Ollama streams NDJSON — one complete JSON object per line.
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const message = obj.message as { content?: string } | undefined;
      if (message?.content) sink.push(message.content);
      if (obj.done === true) {
        if (typeof obj.done_reason === 'string') outcome.stopReason = obj.done_reason;
        if (typeof obj.prompt_eval_count === "number") outcome.promptTokens = obj.prompt_eval_count;
        if (typeof obj.eval_count === "number") outcome.completionTokens = obj.eval_count;
      }
    }
  }
  return outcome;
}

/** Everything that isn't Ollama: LM Studio, Jan, llama.cpp, vLLM — one shape. */
async function runOpenAiCompatible(
  origin: string,
  job: BridgeJob,
  sink: ChunkSink,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const p = job.payload;
  const res = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: p.model,
      messages: p.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(p.response_format?.type === 'json_object' && { response_format: p.response_format }),
      ...(p.max_tokens !== undefined && { max_tokens: p.max_tokens }),
      ...(p.temperature !== undefined && { temperature: p.temperature }),
      ...(p.top_p !== undefined && { top_p: p.top_p }),
      ...(p.frequency_penalty !== undefined && { frequency_penalty: p.frequency_penalty }),
      ...(p.presence_penalty !== undefined && { presence_penalty: p.presence_penalty }),
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Local model returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const outcome: RunOutcome = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      const choices = obj.choices as Array<{ delta?: { content?: string }; finish_reason?: string }> | undefined;
      if (typeof choices?.[0]?.finish_reason === 'string') outcome.stopReason = choices[0].finish_reason;
      const delta = choices?.[0]?.delta?.content;
      if (delta) sink.push(delta);
      const usage = obj.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        if (typeof usage.prompt_tokens === "number") outcome.promptTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === "number") outcome.completionTokens = usage.completion_tokens;
      }
    }
  }
  return outcome;
}

export interface LocalBridgeOptions {
  runtime: RuntimeCandidate;
  models: DetectedModel[];
  onStatus?: (status: BridgeStatus, detail?: string) => void;
}

/**
 * Keeps this tab available as the player's local-model courier until stopped.
 *
 * Deliberately tied to the tab: the connection dies with it, the server sees
 * that immediately, and the player is told their model is offline instead of
 * having turns hang. A background runner that survives the tab is what the
 * desktop companion is for.
 */
export class LocalBridge {
  private source: EventSource | null = null;
  private abort: AbortController | null = null;
  private stopped = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private runtimeDown = false;
  private advertisedAt = 0;

  constructor(private readonly opts: LocalBridgeOptions) {}

  private async announceModels(force=false):Promise<void> {
    if(!force&&Date.now()-this.advertisedAt<60_000)return;
    this.advertisedAt=Date.now();
    try{
      const response=await fetch(`${apiBase}/api/local-bridge/announce`,{
        method:'POST',credentials:'include',headers:{'content-type':'application/json'},
        body:JSON.stringify({models:this.opts.models}),
      });
      if(!response.ok)this.advertisedAt=0;
    }catch{this.advertisedAt=0;}
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.opts.onStatus?.("connecting");

    await this.announceModels(true);
    if (this.stopped) return;

    const source = new EventSource(`${apiBase}/api/local-bridge/poll`, { withCredentials: true });
    this.source = source;

    source.addEventListener("ready", () => {
      if (!this.runtimeDown) this.opts.onStatus?.("connected");
    });
    source.addEventListener("job", (evt) => {
      let job: BridgeJob;
      try {
        job = JSON.parse((evt as MessageEvent).data);
      } catch {
        return;
      }
      void this.runJob(job);
    });
    source.onerror = () => {
      // EventSource reconnects on its own; only say something if we're done.
      if (this.stopped) return;
      this.opts.onStatus?.("connecting");
    };

    // Without this the picker and the composer pill stay green after the
    // player quits Ollama, and the first sign is a turn that fails.
    this.heartbeat = setInterval(() => void this.checkRuntime(), HEARTBEAT_MS);
  }

  private async checkRuntime(): Promise<void> {
    if (this.stopped) return;
    if (this.abort) { await this.announceModels(); return; } // a turn in flight speaks for itself
    const alive = await runtimeAlive(this.opts.runtime);
    if (this.stopped || this.abort) return;
    if (alive) await this.announceModels();
    if (this.stopped || this.abort) return;
    if (!alive && !this.runtimeDown) {
      this.runtimeDown = true;
      this.opts.onStatus?.("error", unreachableMessage(this.opts.runtime));
    } else if (alive && this.runtimeDown) {
      this.runtimeDown = false;
      this.opts.onStatus?.("connected");
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.abort?.abort();
    this.abort = null;
    this.source?.close();
    this.source = null;
    this.opts.onStatus?.("idle");
  }

  private async runJob(job: BridgeJob): Promise<void> {
    // One turn at a time. A second job while one is in flight means the player
    // hit send twice; the newer one wins, same as the chat UI's own behavior.
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;

    const sink = new ChunkSink(job.requestId);
    this.opts.onStatus?.("running");

    try {
      const outcome = this.opts.runtime.native
        ? await runOllama(this.opts.runtime.origin, job, sink, ctrl.signal)
        : await runOpenAiCompatible(this.opts.runtime.origin, job, sink, ctrl.signal);

      await sink.flush();
      await report({
        kind: "done",
        requestId: job.requestId,
        ...(outcome.stopReason && { stopReason: outcome.stopReason }),
        usage: {
          promptTokens: outcome.promptTokens ?? 0,
          completionTokens: outcome.completionTokens ?? 0,
        },
      });
      this.runtimeDown = false;
      this.opts.onStatus?.("connected");
    } catch (err) {
      if (ctrl.signal.aborted) return;
      await sink.flush();
      // A TypeError from fetch means nothing answered at all: the runtime is closed.
      const unreachable = err instanceof TypeError;
      if (unreachable) this.runtimeDown = true;
      const message = unreachable ? unreachableMessage(this.opts.runtime) : err instanceof Error ? err.message : String(err);
      await report({ kind: "error", requestId: job.requestId, message });
      this.opts.onStatus?.("error", message);
    } finally {
      if (this.abort === ctrl) this.abort = null;
    }
  }
}
