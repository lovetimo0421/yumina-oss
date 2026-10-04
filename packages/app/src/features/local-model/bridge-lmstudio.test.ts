import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("../..", import.meta.url)) } },
  server: { middlewareMode: true },
  plugins: [{
    name: "isolated-i18n",
    enforce: "pre",
    load(id: string) {
      if (id.replaceAll("\\", "/").endsWith("/lib/i18n.ts")) return "export default {t:(key,o)=>key+(o&&o.runtime?':'+o.runtime:'')};";
    },
  }],
});
const { LocalBridge, runtimeErrorDetail } = await vite.ssrLoadModule("/src/features/local-model/bridge.ts");
after(() => vite.close());

const LMSTUDIO = { kind: "lmstudio", label: "LM Studio", origin: "http://127.0.0.1:1234", native: false };
const OLLAMA = { kind: "ollama", label: "Ollama", origin: "http://127.0.0.1:11434", native: true };

const QWEN = {
  type: "llm",
  key: "qwen/qwen3.8-27b",
  max_context_length: 262144,
  loaded_instances: [{ id: "qwen/qwen3.8-27b", config: { context_length: 262144 } }],
  capabilities: { reasoning: { allowed_options: ["off", "on"], default: "on" } },
};

/** An SSE body the way LM Studio streams one. */
function sse(...frames: string[]): Response {
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
const delta = (content: string, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content, ...extra } }] })}\n\n`;
const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`;

/** A JSON request body the bridge sent to a runtime. */
interface Sent {
  model?: string;
  instance_id?: string;
  context_length?: number;
  messages?: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
}

/** What the bridge reported back to the server. */
interface Report {
  kind: string;
  delta?: string;
  message?: string;
}

type Route = (url: string, body: Sent) => Response | Promise<Response> | undefined;

interface Turn {
  reports: Report[];
  /** Every request that reached a runtime: [url, body]. */
  calls: Array<[string, Sent]>;
}

/**
 * Start a bridge against fake runtimes, hand it one job per payload, and
 * collect what it reported back and what it asked the runtimes.
 */
async function runTurns(runtimes: unknown[], payloads: unknown[], route: Route): Promise<Turn> {
  const originalFetch = globalThis.fetch;
  const eventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  class Source extends EventTarget { static current: Source; onerror = null; constructor() { super(); Source.current = this; } close() {} }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Source });
  const turn: Turn = { reports: [], calls: [] };
  let settle!: () => void;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Sent & Report;
    if (url.endsWith("/announce")) return Response.json({ ok: true });
    if (url.endsWith("/report")) {
      turn.reports.push(body);
      if (body.kind === "done" || body.kind === "error") settle();
      return Response.json({ ok: true });
    }
    turn.calls.push([url, body]);
    const res = await route(url, body);
    if (!res) throw new TypeError("Failed to fetch");
    return res;
  }) as typeof fetch;
  const bridge = new LocalBridge({ runtimes });
  try {
    await bridge.start();
    for (const [i, payload] of payloads.entries()) {
      const settled = new Promise<void>((r) => { settle = r; });
      Source.current.dispatchEvent(new MessageEvent("job", { data: JSON.stringify({ requestId: `job${i}`, payload }) }));
      await settled;
    }
    return turn;
  } finally {
    bridge.stop();
    globalThis.fetch = originalFetch;
    if (eventSource) Object.defineProperty(globalThis, "EventSource", eventSource);
    else Reflect.deleteProperty(globalThis, "EventSource");
  }
}

const chatCalls = (turn: Turn) => turn.calls.filter(([url]) => url.endsWith("/v1/chat/completions")).map(([, body]) => body);
const text = (turn: Turn) => turn.reports.filter((r) => r.kind === "chunk").map((r) => r.delta).join("");

/** Yumina's real prompt shape: several system blocks, one mid-history, a greeting first. */
const PROMPT = [
  { role: "system", content: "preset" },
  { role: "system", content: "persona" },
  { role: "assistant", content: "Welcome, traveller." },
  { role: "system", content: "[lore]" },
  { role: "user", content: "I look around." },
  { role: "system", content: "<game-state/>" },
];

test("an LM Studio turn goes out in a shape its chat template accepts, with thinking off", async () => {
  const turn = await runTurns(
    [{ runtime: LMSTUDIO, models: [{ id: QWEN.key, loaded: true, contextLength: 262144, reasoningOptions: ["off", "on"] }] }],
    [{ model: QWEN.key, messages: PROMPT, max_tokens: 2048, think: false, top_k: 40, min_p: 0.05 }],
    (url) => {
      if (url.endsWith("/api/v1/models")) return Response.json({ models: [QWEN] });
      if (url.endsWith("/v1/chat/completions")) return sse(delta("You see "), delta("a hall."), finish);
    },
  );
  const [body] = chatCalls(turn);
  assert.deepEqual(body.messages, [
    { role: "system", content: "preset\n\npersona" },
    { role: "user", content: "[Start]" },
    { role: "assistant", content: "Welcome, traveller." },
    { role: "user", content: "[lore]\n\nI look around.\n\n<game-state/>" },
  ]);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.top_k, 40);
  assert.equal(body.min_p, 0.05);
  assert.equal(text(turn), "You see a hall.");
  assert.equal(turn.reports.at(-1)?.kind, "done");
});

test("an error LM Studio streams inside a 200 is reported, not swallowed as an empty reply", async () => {
  const turn = await runTurns(
    [{ runtime: LMSTUDIO, models: [{ id: QWEN.key, loaded: true, contextLength: 262144 }] }],
    [{ model: QWEN.key, messages: [{ role: "user", content: "hi" }] }],
    (url) => {
      if (url.endsWith("/api/v1/models")) return Response.json({ models: [QWEN] });
      if (url.endsWith("/v1/chat/completions")) return sse(`event: error\ndata: ${JSON.stringify({ error: { message: "Model unloaded." } })}\n\n`);
    },
  );
  assert.deepEqual(turn.reports.map((r) => r.kind), ["error"]);
  assert.equal(turn.reports[0].message, "LM Studio: Model unloaded.");
});

test("a template with no system role gets one retry with the instructions in the first turn", async () => {
  const rejection = { error: { message: 'Engine protocol predict request returned 500: {"error":{"code":500,"message":"Error: Jinja Exception: System role not supported","type":"server_error"}}' } };
  const turn = await runTurns(
    [{ runtime: LMSTUDIO, models: [{ id: "gemma-2-9b", loaded: true, contextLength: 8192 }] }],
    [
      { model: "gemma-2-9b", messages: [{ role: "system", content: "persona" }, { role: "user", content: "hi" }] },
      { model: "gemma-2-9b", messages: [{ role: "system", content: "persona" }, { role: "user", content: "again" }] },
    ],
    (url, body) => {
      if (url.endsWith("/api/v1/models")) return Response.json({ models: [{ type: "llm", key: "gemma-2-9b", max_context_length: 8192, loaded_instances: [{ config: { context_length: 8192 } }] }] });
      if (!url.endsWith("/v1/chat/completions")) return undefined;
      if (body.messages?.[0]?.role === "system") return sse(`event: error\ndata: ${JSON.stringify(rejection)}\n\n`);
      return sse(delta("Hello."), finish);
    },
  );
  const bodies = chatCalls(turn);
  // First turn: rejected, then retried without a system role. Second turn: straight to the shape that works.
  assert.deepEqual(bodies.map((b) => b.messages?.[0]?.role), ["system", "user", "user"]);
  assert.equal(bodies[1]?.messages?.[0]?.content, "persona\n\nhi");
  assert.deepEqual(turn.reports.map((r) => r.kind), ["chunk", "done", "chunk", "done"]);
});

test("a model LM Studio hasn't loaded is loaded at the context the server packed for, and swapped out after", async () => {
  const listed = (loaded: string | null) => Response.json({
    models: ["cydonia-22b", "mistral-7b"].map((key) => ({
      type: "llm",
      key,
      max_context_length: 131072,
      loaded_instances: loaded === key ? [{ id: `${key}-instance`, config: { context_length: 32768 } }] : [],
    })),
  });
  let loaded: string | null = null;
  const turn = await runTurns(
    [{ runtime: LMSTUDIO, models: [{ id: "cydonia-22b", loaded: false, contextLength: 32768 }, { id: "mistral-7b", loaded: false, contextLength: 32768 }] }],
    [
      { model: "cydonia-22b", messages: [{ role: "user", content: "hi" }] },
      { model: "mistral-7b", messages: [{ role: "user", content: "hi" }] },
    ],
    (url, body) => {
      if (url.endsWith("/api/v1/models")) return listed(loaded);
      if (url.endsWith("/api/v1/models/load")) {
        loaded = body.model ?? null;
        return Response.json({ type: "llm", instance_id: `${body.model}-instance`, status: "loaded" });
      }
      if (url.endsWith("/api/v1/models/unload")) return Response.json({ instance_id: body.instance_id });
      if (url.endsWith("/v1/chat/completions")) return sse(delta("ok"), finish);
    },
  );
  const lifecycle = turn.calls
    .filter(([url]) => /models\/(load|unload)$/.test(url))
    .map(([url, body]) => `${url.endsWith("unload") ? "unload" : "load"} ${body.instance_id ?? `${body.model}@${body.context_length}`}`);
  assert.deepEqual(lifecycle, ["load cydonia-22b@32768", "unload cydonia-22b-instance", "load mistral-7b@32768"]);
  assert.deepEqual(turn.reports.map((r) => r.kind), ["chunk", "done", "chunk", "done"]);
});

test("each turn goes to the runtime that has the model, Ollama and LM Studio side by side", async () => {
  const turn = await runTurns(
    [
      { runtime: LMSTUDIO, models: [{ id: QWEN.key, loaded: true, contextLength: 262144 }] },
      { runtime: OLLAMA, models: [{ id: "qwen3.5:9b" }] },
    ],
    [
      { model: "qwen3.5:9b", messages: [{ role: "user", content: "hi" }] },
      { model: QWEN.key, messages: [{ role: "user", content: "hi" }] },
    ],
    (url) => {
      if (url.endsWith("/api/v1/models")) return Response.json({ models: [QWEN] });
      if (url === "http://127.0.0.1:11434/api/chat") return new Response(JSON.stringify({ message: { content: "from ollama" }, done: true }) + "\n");
      if (url === "http://127.0.0.1:1234/v1/chat/completions") return sse(delta("from lm studio"), finish);
    },
  );
  const turns = turn.reports.filter((r) => r.kind === "chunk").map((r) => r.delta);
  assert.deepEqual(turns, ["from ollama", "from lm studio"]);
});

test("thinking that arrives inline is kept out of the story", async () => {
  const turn = await runTurns(
    [{ runtime: LMSTUDIO, models: [{ id: QWEN.key, loaded: true, contextLength: 262144 }] }],
    [{ model: QWEN.key, messages: [{ role: "user", content: "hi" }] }],
    (url) => {
      if (url.endsWith("/api/v1/models")) return Response.json({ models: [QWEN] });
      if (url.endsWith("/v1/chat/completions")) return sse(delta("<thi"), delta("nk>plan the scene</th"), delta("ink>\n\nThe door "), delta("opens."), finish);
    },
  );
  assert.equal(text(turn), "The door opens.");
});

test("a reply that was all thinking says so instead of coming back blank", async () => {
  const turn = await runTurns(
    [{ runtime: LMSTUDIO, models: [{ id: QWEN.key, loaded: true, contextLength: 262144 }] }],
    [{ model: QWEN.key, messages: [{ role: "user", content: "hi" }] }],
    (url) => {
      if (url.endsWith("/api/v1/models")) return Response.json({ models: [QWEN] });
      if (url.endsWith("/v1/chat/completions")) return sse(delta("", { reasoning_content: "Let me think about this at length" }), finish);
    },
  );
  assert.deepEqual(turn.reports.map((r) => r.kind), ["error"]);
  assert.match(turn.reports[0]?.message ?? "", /^LM Studio: the model used its whole reply thinking/);
});

test("LM Studio's nested error bodies come out readable", () => {
  const nested = JSON.stringify({ error: 'Engine protocol predict request returned 500: {"error":{"code":500,"message":"\\n------------\\nWhile executing CallExpression at line 106, column 32 in source:\\n...first %}\\n {{- raise_exception(\'System message must be at the beginnin...\\n ^\\nError: Jinja Exception: System message must be at the beginning.","type":"server_error"}}' });
  assert.equal(runtimeErrorDetail(nested), "the model's chat template rejected the conversation (System message must be at the beginning.)");
  assert.equal(runtimeErrorDetail(JSON.stringify({ error: "'response_format.type' must be 'json_schema' or 'text'" })), "'response_format.type' must be 'json_schema' or 'text'");
  assert.equal(runtimeErrorDetail("", 502), "HTTP 502");
});
