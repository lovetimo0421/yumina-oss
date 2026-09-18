import assert from "node:assert/strict";
import test from "node:test";
import { createSideCallStreamReader } from "./side-call-stream";

/** Collect what a card would observe from one side call. */
function record() {
  const deltas: string[] = [];
  let done: string | null = null;
  let error: string | null = null;
  const reader = createSideCallStreamReader({
    onDelta: (t) => deltas.push(t),
    onDone: (t) => {
      done = t;
    },
    onError: (e) => {
      error = e;
    },
  });
  return { reader, deltas, get done() { return done; }, get error() { return error; } };
}

/** Exactly what packages/server/src/routes/completions.ts writes on the wire. */
function serverStream(chunks: string[], opts: { error?: string } = {}) {
  let out = "";
  let full = "";
  for (const c of chunks) {
    full += c;
    out += `event: text\ndata: ${JSON.stringify({ content: c })}\n\n`;
  }
  if (opts.error) {
    out += `event: error\ndata: ${JSON.stringify({ error: opts.error })}\n\n`;
  }
  out += `event: done\ndata: ${JSON.stringify({
    content: full,
    usage: { promptTokens: 10, completionTokens: 20 },
  })}\n\n`;
  return out;
}

test("the done frame does not append the reply a second time", () => {
  const r = record();
  r.reader.push(serverStream(["Hello ", "world"]));
  r.reader.end();
  assert.equal(r.done, "Hello world");
  assert.equal(r.error, null);
});

test("a JSON decision survives the round trip and stays parseable", () => {
  // The liarsbar regression: doubling produced `{...}{...}`, which JSON.parse
  // rejects, so every AI turn silently fell back to hardcoded lines.
  const decision = { action: "play", cards: [0, 2], talk: "就这点胆子？" };
  const text = JSON.stringify(decision);
  const r = record();
  r.reader.push(serverStream([text.slice(0, 12), text.slice(12)]));
  r.reader.end();
  assert.equal(r.done, text);
  assert.deepEqual(JSON.parse(r.done as unknown as string), decision);
});

test("onDelta only sees streamed chunks, never the full reply again", () => {
  const r = record();
  r.reader.push(serverStream(["a", "b", "c"]));
  r.reader.end();
  assert.deepEqual(r.deltas, ["a", "b", "c"]);
});

test("an error frame settles as an error, not a successful reply", () => {
  const r = record();
  r.reader.push(serverStream(["partial"], { error: "Upstream refused" }));
  r.reader.end();
  assert.equal(r.error, "Upstream refused");
  assert.equal(r.done, null);
});

test("an error frame with no message still reports a failure", () => {
  const r = record();
  r.reader.push('event: error\ndata: {}\n\n');
  r.reader.end();
  assert.equal(r.error, "Generation failed");
  assert.equal(r.done, null);
});

test("frames split across arbitrary chunk boundaries reassemble", () => {
  const wire = serverStream(["Hello ", "world"]);
  for (const size of [1, 3, 7, 40]) {
    const r = record();
    for (let i = 0; i < wire.length; i += size) r.reader.push(wire.slice(i, i + size));
    r.reader.end();
    assert.equal(r.done, "Hello world", `chunk size ${size}`);
  }
});

test("a body that ends without a done frame hands back what streamed", () => {
  const r = record();
  r.reader.push('event: text\ndata: {"content":"half a s"}\n\n');
  r.reader.end();
  assert.equal(r.done, "half a s");
  assert.equal(r.error, null);
});

test("a done frame without content falls back to the accumulated text", () => {
  const r = record();
  r.reader.push('event: text\ndata: {"content":"abc"}\n\n');
  r.reader.push('event: done\ndata: {"usage":{}}\n\n');
  r.reader.end();
  assert.equal(r.done, "abc");
});

test("comments, keep-alive blanks, and malformed frames are skipped", () => {
  const r = record();
  r.reader.push(": keep-alive\n\n");
  r.reader.push('event: text\ndata: {"content":"ok"}\n\n');
  r.reader.push("event: text\ndata: {not json}\n\n");
  r.reader.push("\n\n");
  r.reader.end();
  assert.equal(r.done, "ok");
  assert.deepEqual(r.deltas, ["ok"]);
});

test("CRLF line endings parse the same as LF", () => {
  const r = record();
  r.reader.push('event: text\r\ndata: {"content":"crlf"}\r\n\r\n');
  r.reader.push('event: done\r\ndata: {"content":"crlf"}\r\n\r\n');
  r.reader.end();
  assert.equal(r.done, "crlf");
});

test("the call settles exactly once even if more frames arrive", () => {
  let doneCount = 0;
  let errorCount = 0;
  const reader = createSideCallStreamReader({
    onDelta: () => {},
    onDone: () => { doneCount += 1; },
    onError: () => { errorCount += 1; },
  });
  reader.push(serverStream(["x"]));
  reader.push(serverStream(["y"]));
  reader.push('event: error\ndata: {"error":"late"}\n\n');
  reader.end();
  assert.equal(doneCount, 1);
  assert.equal(errorCount, 0);
});

test("a data line with no space after the colon still parses", () => {
  const r = record();
  r.reader.push('event:text\ndata:{"content":"tight"}\n\n');
  r.reader.end();
  assert.equal(r.done, "tight");
});
