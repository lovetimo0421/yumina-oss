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
import { isTemplateError, toTemplateSafeMessages } from "./chat-template";
import {
  listRuntimeModels,
  readLmStudioModels,
  readyResult,
  RUNTIME_CANDIDATES,
  type DetectedModel,
  type RuntimeCandidate,
  type RuntimeKind,
  type RuntimeModels,
} from "./detect";

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
  /** Whether any text has been handed over yet — after that a turn can't be retried. */
  started = false;
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
    this.started = true;
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

/** The runtime answered, and what it said was an error. */
class RuntimeError extends Error {
  constructor(runtime: RuntimeCandidate, readonly detail: string) {
    super(`${runtime.label}: ${detail}`);
    this.name = "RuntimeError";
  }
}

/**
 * The readable part of a runtime's error body.
 *
 * LM Studio nests them: `{"error":"Engine protocol predict request returned
 * 500: {\"error\":{\"message\":\"…Jinja Exception: System message must be at
 * the beginning.\"}}"}`. Peel the JSON layers, and for a template exception
 * keep just the sentence that says what the template objected to.
 */
export function runtimeErrorDetail(raw: string, status?: number): string {
  let text = raw.trim();
  for (let depth = 0; depth < 4; depth++) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) break;
    let next: unknown;
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { error?: unknown; message?: unknown };
      const error = obj.error as { message?: unknown } | string | undefined;
      next = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : obj.message;
    } catch {
      break;
    }
    if (typeof next !== "string" || !next.trim() || next.trim() === text) break;
    text = next.trim();
  }
  const jinja = /Jinja Exception:\s*([^\n"]+)/.exec(text);
  if (jinja) return `the model's chat template rejected the conversation (${jinja[1]!.trim()})`;
  const flat = text.replace(/\s+/g, " ").trim().slice(0, 300);
  return flat || (status ? `HTTP ${status}` : "unknown error");
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

/**
 * LM Studio refuses `json_object` ("'response_format.type' must be
 * 'json_schema' or 'text'"); an open object schema asks for the same thing.
 */
const LMSTUDIO_JSON_OBJECT = { type: "json_schema", json_schema: { name: "response", schema: { type: "object" } } };

/** Runtimes whose OpenAI endpoint also takes llama.cpp's samplers. */
const EXTENDED_SAMPLING = new Set<RuntimeKind>(["lmstudio", "llamacpp"]);

/**
 * The `reasoning_effort` that turns this LM Studio model's thinking off, or
 * down as far as it goes — the OpenAI-shaped twin of Ollama's `think: false`
 * (see LocalBridgeProvider for why turns run without it). Undefined for models
 * that don't reason, or when LM Studio didn't say.
 */
function reasoningOff(model: DetectedModel | undefined): string | undefined {
  const options = model?.reasoningOptions ?? [];
  if (options.includes("off")) return "none";
  if (options.includes("low")) return "low";
  return undefined;
}

/**
 * Drops a leading <think>…</think> block. LM Studio and llama.cpp normally
 * stream reasoning in its own field, which we skip; with that split turned off
 * the thinking arrives inline and would land in the story as prose.
 */
class LeadingThinkFilter {
  private state: "start" | "thinking" | "text" = "start";
  private held = "";
  private trimLead = false;

  push(delta: string): string {
    if (this.state === "text") {
      if (!this.trimLead) return delta;
      const rest = delta.replace(/^\s+/, "");
      if (rest) this.trimLead = false;
      return rest;
    }
    this.held += delta;
    if (this.state === "start") {
      const lead = this.held.trimStart();
      if (lead.startsWith("<think>")) {
        this.state = "thinking";
        this.held = lead.slice("<think>".length);
      } else if ("<think>".startsWith(lead)) {
        return ""; // could still turn out to be the tag
      } else {
        this.state = "text";
        const out = this.held;
        this.held = "";
        return out;
      }
    }
    const end = this.held.indexOf("</think>");
    if (end < 0) {
      // Keep enough to catch a closing tag split across deltas.
      this.held = this.held.slice(-("</think>".length - 1));
      return "";
    }
    this.state = "text";
    this.trimLead = true;
    const out = this.held.slice(end + "</think>".length);
    this.held = "";
    return this.push(out);
  }

  /** Text held back while it still looked like the start of a tag. */
  flush(): string {
    if (this.state !== "start") return "";
    this.state = "text";
    const out = this.held;
    this.held = "";
    return out;
  }
}

/** Everything that isn't Ollama: LM Studio, Jan, llama.cpp, vLLM — one shape. */
async function runOpenAiCompatible(
  runtime: RuntimeCandidate,
  job: BridgeJob,
  sink: ChunkSink,
  signal: AbortSignal,
  opts: { systemRole: boolean; model?: DetectedModel },
): Promise<RunOutcome> {
  const p = job.payload;
  const lmStudio = runtime.kind === "lmstudio";
  const extended = EXTENDED_SAMPLING.has(runtime.kind);
  const reasoningEffort = lmStudio && p.think === false ? reasoningOff(opts.model) : undefined;
  const res = await fetch(`${runtime.origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: p.model,
      // These runtimes render with the model's own Jinja template, which
      // rejects the shape our prompts come in. See chat-template.ts.
      messages: toTemplateSafeMessages(p.messages, { systemRole: opts.systemRole }),
      stream: true,
      stream_options: { include_usage: true },
      ...(p.response_format?.type === 'json_object' && { response_format: lmStudio ? LMSTUDIO_JSON_OBJECT : p.response_format }),
      ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
      ...(p.max_tokens !== undefined && { max_tokens: p.max_tokens }),
      ...(p.temperature !== undefined && { temperature: p.temperature }),
      ...(p.top_p !== undefined && { top_p: p.top_p }),
      ...(extended && p.top_k !== undefined && { top_k: p.top_k }),
      ...(extended && p.min_p !== undefined && { min_p: p.min_p }),
      ...(p.frequency_penalty !== undefined && { frequency_penalty: p.frequency_penalty }),
      ...(p.presence_penalty !== undefined && { presence_penalty: p.presence_penalty }),
    }),
  });
  if (!res.ok || !res.body) {
    throw new RuntimeError(runtime, runtimeErrorDetail(await res.text().catch(() => ""), res.status));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const think = new LeadingThinkFilter();
  let buf = "";
  let event = "";
  let reasoningChars = 0;
  const outcome: RunOutcome = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) {
        event = ""; // a blank line ends one SSE event
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let obj: Record<string, unknown> | null = null;
      try {
        obj = JSON.parse(data);
      } catch {
        // Unparseable data only matters if it was announced as an error.
      }
      // A generation that fails after the stream opened — a template that
      // rejects the prompt, a model that won't load — arrives inside the 200
      // response as `event: error`. Reading only `choices` turned it into an
      // empty "done" and the turn silently came back blank.
      if (event === "error" || (obj && obj.error)) throw new RuntimeError(runtime, runtimeErrorDetail(data));
      if (!obj) continue;
      const choices = obj.choices as Array<{
        delta?: { content?: string; reasoning_content?: string; reasoning?: string };
        finish_reason?: string;
      }> | undefined;
      const choice = choices?.[0];
      if (typeof choice?.finish_reason === 'string') outcome.stopReason = choice.finish_reason;
      reasoningChars += (choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? "").length;
      const delta = choice?.delta?.content;
      if (delta) sink.push(think.push(delta));
      const usage = obj.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        if (typeof usage.prompt_tokens === "number") outcome.promptTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === "number") outcome.completionTokens = usage.completion_tokens;
      }
    }
  }
  sink.push(think.flush());
  if (!sink.started && reasoningChars > 0) {
    throw new RuntimeError(runtime, "the model used its whole reply thinking and wrote nothing. Turn reasoning off for this model, or pick one that doesn't reason.");
  }
  return outcome;
}

export interface LocalBridgeOptions {
  /** Every runtime to serve, best first (see detectLocalRuntime). */
  runtimes: RuntimeModels[];
  onStatus?: (status: BridgeStatus, detail?: string) => void;
  /** What's running changed: a model pulled, loaded or unloaded, a runtime started or closed. */
  onRuntimes?: (runtimes: RuntimeModels[]) => void;
}

/** Every Nth heartbeat also looks for a runtime started since we connected. */
const DISCOVER_EVERY = 4;

/**
 * Keeps this tab available as the player's local-model courier until stopped.
 *
 * It serves every runtime that answered — Ollama and LM Studio side by side —
 * and sends each turn to the one that has the model the player picked.
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
  /** No runtime answers at all, and the player has been told. */
  private runtimeDown = false;
  /** The runtime the last turn found closed, until it answers again. */
  private unreachable: RuntimeKind | null = null;
  private advertisedAt = 0;
  private runtimes: RuntimeModels[];
  /** Runtimes that didn't answer the last check. */
  private down = new Set<RuntimeKind>();
  private beats = 0;
  private checking = false;
  /** `kind:model` pairs whose template has no system role; they get the strict shape. */
  private readonly noSystemRole = new Set<string>();
  /** LM Studio instances this tab loaded, and so may unload again. */
  private loadedByBridge: string[] = [];

  constructor(private readonly opts: LocalBridgeOptions) {
    this.runtimes = opts.runtimes;
  }

  /** Everything the player can pick, across runtimes. */
  private get models(): DetectedModel[] {
    return this.runtimes.length > 0 ? readyResult(this.runtimes).models : [];
  }

  /** The runtime that has this model; the lead one when none admits to it. */
  private runtimeFor(modelId: string): RuntimeModels {
    return this.runtimes.find((r) => r.models.some((m) => m.id === modelId)) ?? this.runtimes[0]!;
  }

  private async announceModels(force=false):Promise<void> {
    if(!force&&Date.now()-this.advertisedAt<60_000)return;
    this.advertisedAt=Date.now();
    try{
      const response=await fetch(`${apiBase}/api/local-bridge/announce`,{
        method:'POST',credentials:'include',headers:{'content-type':'application/json'},
        body:JSON.stringify({models:this.models}),
      });
      if(!response.ok)this.advertisedAt=0;
    }catch{this.advertisedAt=0;}
  }

  /**
   * Take fresh model lists. The server packs each prompt for the context we
   * advertise, so a model reloaded at a different size in LM Studio has to
   * reach it before the next turn, not in five minutes.
   */
  private async setRuntimes(next: RuntimeModels[]): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(this.runtimes)) return;
    this.runtimes = next;
    this.opts.onRuntimes?.(next);
    await this.announceModels(true);
  }

  private replaceModels(kind: RuntimeKind, models: DetectedModel[]): Promise<void> {
    return this.setRuntimes(this.runtimes.map((r) => (r.runtime.kind === kind ? { ...r, models } : r)));
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
    this.heartbeat = setInterval(() => void this.checkRuntimes(), HEARTBEAT_MS);
  }

  /**
   * Between turns, re-list what's connected — which is the liveness check, and
   * carries models pulled, loaded or unloaded since — and every few beats look
   * for a runtime started since (LM Studio opened after Ollama, or the reverse).
   */
  private async checkRuntimes(): Promise<void> {
    if (this.stopped || this.checking) return;
    if (this.abort) { await this.announceModels(); return; } // a turn in flight speaks for itself
    this.checking = true;
    try {
      const known = new Set(this.runtimes.map((r) => r.runtime.kind));
      const discover = ++this.beats % DISCOVER_EVERY === 0;
      const candidates = [
        ...this.runtimes.map((r) => r.runtime),
        ...(discover ? RUNTIME_CANDIDATES.filter((c) => !known.has(c.kind)) : []),
      ];
      const answers = await Promise.all(candidates.map(async (runtime) => ({
        runtime,
        models: await listRuntimeModels(runtime, AbortSignal.timeout(3_000)).catch(() => null),
      })));
      if (this.stopped || this.abort) return;
      const fresh = answers.filter((a): a is RuntimeModels => a.models !== null && (known.has(a.runtime.kind) || a.models.length > 0));
      this.down = new Set([...known].filter((kind) => !fresh.some((a) => a.runtime.kind === kind)));
      // A runtime that stopped answering keeps its place and its models: a turn
      // on one then says plainly that it's closed, rather than the model
      // vanishing from under the player.
      await this.setRuntimes([
        ...this.runtimes.map((r) => fresh.find((a) => a.runtime.kind === r.runtime.kind) ?? r),
        ...fresh.filter((a) => !known.has(a.runtime.kind)),
      ]);
      if (this.stopped || this.abort) return;
      const allDown = this.runtimes.every((r) => this.down.has(r.runtime.kind));
      if (!allDown) await this.announceModels();
      if (this.stopped || this.abort) return;
      if (allDown && !this.runtimeDown) {
        this.runtimeDown = true;
        this.opts.onStatus?.("error", unreachableMessage(this.runtimes[0]!.runtime));
      } else if (!allDown && (this.runtimeDown || (this.unreachable && !this.down.has(this.unreachable)))) {
        this.runtimeDown = false;
        this.unreachable = null;
        this.opts.onStatus?.("connected");
      }
    } finally {
      this.checking = false;
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

  /**
   * Make sure LM Studio has the model in memory at the context we advertised.
   *
   * Left alone, LM Studio loads a model on first request at ITS default window
   * (8,192 since 0.4.16) while the server packed the prompt for ours, and the
   * turn overflows. So a model that isn't loaded is loaded here, explicitly, at
   * the size we told the server. A copy the player loaded by hand is never
   * touched: we advertise its real window instead.
   */
  private async ensureLmStudioLoaded(runtime: RuntimeCandidate, modelId: string, signal: AbortSignal): Promise<void> {
    const models = await readLmStudioModels(runtime.origin, signal).catch(() => null);
    if (!models) return; // can't tell; let LM Studio load it its own way
    await this.replaceModels(runtime.kind, models);
    const entry = models.find((m) => m.id === modelId);
    // Only the 0.4+ list gives a load size (see readLmStudioModels); older
    // versions have no load endpoint either, and load on request as before.
    if (!entry || entry.loaded !== false || !entry.contextLength) return;

    // The same courtesy as LM Studio's "unload previous JIT model": switching
    // models in Yumina shouldn't stack them in VRAM — but only for ours.
    for (const instanceId of this.loadedByBridge.splice(0)) {
      await fetch(`${runtime.origin}/api/v1/models/unload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance_id: instanceId }),
        signal,
      }).catch(() => undefined);
    }

    const res = await fetch(`${runtime.origin}/api/v1/models/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, context_length: entry.contextLength }),
      signal,
    });
    if (!res.ok) {
      throw new RuntimeError(runtime, `couldn't load ${modelId}: ${runtimeErrorDetail(await res.text().catch(() => ""), res.status)}`);
    }
    const loaded = (await res.json().catch(() => null)) as { instance_id?: unknown } | null;
    if (typeof loaded?.instance_id === "string") this.loadedByBridge.push(loaded.instance_id);
    const fresh = await readLmStudioModels(runtime.origin, signal).catch(() => null);
    if (fresh) await this.replaceModels(runtime.kind, fresh);
  }

  private async runCompatible(runtime: RuntimeCandidate, job: BridgeJob, sink: ChunkSink, signal: AbortSignal): Promise<RunOutcome> {
    const modelId = job.payload.model;
    const model = this.runtimes.find((r) => r.runtime.kind === runtime.kind)?.models.find((m) => m.id === modelId);
    const key = `${runtime.kind}:${modelId}`;
    const strict = this.noSystemRole.has(key);
    try {
      return await runOpenAiCompatible(runtime, job, sink, signal, { systemRole: !strict, model });
    } catch (err) {
      // A template with no system role at all (Gemma 2, early Mistral) rejects
      // the request before generating anything. Retry once with the
      // instructions folded into the first turn, and remember the model.
      if (strict || sink.started || !(err instanceof RuntimeError) || !isTemplateError(err.detail)) throw err;
      this.noSystemRole.add(key);
      return runOpenAiCompatible(runtime, job, sink, signal, { systemRole: false, model });
    }
  }

  private async runJob(job: BridgeJob): Promise<void> {
    // One turn at a time. A second job while one is in flight means the player
    // hit send twice; the newer one wins, same as the chat UI's own behavior.
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;

    const sink = new ChunkSink(job.requestId);
    const { runtime } = this.runtimeFor(job.payload.model);
    this.opts.onStatus?.("running");

    try {
      if (runtime.kind === "lmstudio") await this.ensureLmStudioLoaded(runtime, job.payload.model, ctrl.signal);
      const outcome = runtime.native
        ? await runOllama(runtime.origin, job, sink, ctrl.signal)
        : await this.runCompatible(runtime, job, sink, ctrl.signal);

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
      this.down.delete(runtime.kind);
      this.runtimeDown = false;
      this.unreachable = null;
      this.opts.onStatus?.("connected");
    } catch (err) {
      if (ctrl.signal.aborted) return;
      await sink.flush();
      // A TypeError from fetch means nothing answered at all: the runtime is closed.
      const unreachable = err instanceof TypeError;
      if (unreachable) {
        this.down.add(runtime.kind);
        this.unreachable = runtime.kind;
        this.runtimeDown = this.runtimes.every((r) => this.down.has(r.runtime.kind));
      }
      const message = unreachable ? unreachableMessage(runtime) : err instanceof Error ? err.message : String(err);
      await report({ kind: "error", requestId: job.requestId, message });
      this.opts.onStatus?.("error", message);
    } finally {
      if (this.abort === ctrl) this.abort = null;
    }
  }
}
