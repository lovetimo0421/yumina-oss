import assert from "node:assert/strict";
import test from "node:test";
import { FalRefused, FAL_SHOT_ENDPOINT, falPicture, falShot } from "./fal-film.js";

/** A fake fal queue: submit → status (IN_PROGRESS once, then COMPLETED) → response. */
function queue(response: unknown, opts: { submit?: unknown; responseStatus?: number } = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  let polls = 0;
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("https://queue.fal.run/") && init?.method === "POST") {
      return new Response(JSON.stringify(opts.submit ?? { request_id: "req-1", status_url: "https://q.test/status", response_url: "https://q.test/response" }), { status: 200 });
    }
    if (url === "https://q.test/status") return new Response(JSON.stringify({ status: polls++ ? "COMPLETED" : "IN_PROGRESS" }));
    if (url === "https://q.test/response") return new Response(JSON.stringify(response), { status: opts.responseStatus ?? 200 });
    if (url === "https://cdn.test/v.mp4") return new Response(new Uint8Array(2048));
    if (url === "https://cdn.test/p.png") return new Response(new Uint8Array([9, 9, 9]));
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { calls, request };
}

test("a shot starts on its frame, 768p with sound, and comes back with its bytes and price", async () => {
  const { calls, request } = queue({ video: { url: "https://cdn.test/v.mp4" } });
  const out = await falShot({ prompt: "Gondo writes on the board.", frame: "data:image/png;base64,AAAA", deadlineAt: Date.now() + 5_000, deps: { key: "k", request, pollMs: 1 } });
  const submit = calls[0]!;
  assert.equal(submit.url, `https://queue.fal.run/${FAL_SHOT_ENDPOINT}`);
  assert.equal(submit.body?.image_url, "data:image/png;base64,AAAA");
  assert.equal(submit.body?.resolution, "768P");
  assert.equal(submit.body?.duration, 5);
  assert.equal(out.bytes.length, 2048);
  assert.equal(out.requestId, "req-1");
  // ffprobe cannot read the fake bytes: priced at the default length.
  assert.ok(out.usd > 0.19 && out.usd < 0.25);
});

test("a shot without a frame sends no image_url", async () => {
  const { calls, request } = queue({ video: { url: "https://cdn.test/v.mp4" } });
  await falShot({ prompt: "A forest.", frame: null, deadlineAt: Date.now() + 5_000, deps: { key: "k", request, pollMs: 1 } });
  assert.equal("image_url" in calls[0]!.body!, false);
});

test("a content-checker refusal is a FalRefused (the Comfy path films it instead)", async () => {
  const { request } = queue({ detail: [{ type: "content_policy_violation", msg: "flagged by a content checker" }] }, { responseStatus: 422 });
  await assert.rejects(falShot({ prompt: "x", frame: null, deadlineAt: Date.now() + 5_000, deps: { key: "k", request, pollMs: 1 } }), FalRefused);
});

test("a refusal at submit is a FalRefused too; any other failure is a plain error", async () => {
  const refused = queue({}, { submit: { detail: [{ type: "prompt_expansion_failed" }] } });
  await assert.rejects(falShot({ prompt: "x", frame: null, deadlineAt: Date.now() + 5_000, deps: { key: "k", request: refused.request, pollMs: 1 } }), FalRefused);
  const broken = queue({}, { submit: { detail: "server error" } });
  await assert.rejects(
    falShot({ prompt: "x", frame: null, deadlineAt: Date.now() + 5_000, deps: { key: "k", request: broken.request, pollMs: 1 } }),
    (e: unknown) => e instanceof Error && !(e instanceof FalRefused),
  );
});

test("a picture edits from its references, or draws from the prompt alone without any", async () => {
  const withRefs = queue({ images: [{ url: "https://cdn.test/p.png" }] });
  const a = await falPicture("the gym", ["data:image/png;base64,AA"], 7, Date.now() + 5_000, { key: "k", request: withRefs.request, pollMs: 1 });
  assert.match(withRefs.calls[0]!.url, /klein\/9b\/edit$/);
  assert.deepEqual(withRefs.calls[0]!.body?.image_urls, ["data:image/png;base64,AA"]);
  assert.equal(a.bytes.length, 3);
  const bare = queue({ images: [{ url: "https://cdn.test/p.png" }] });
  await falPicture("the gym", [], 7, Date.now() + 5_000, { key: "k", request: bare.request, pollMs: 1 });
  assert.match(bare.calls[0]!.url, /klein\/9b$/);
  assert.equal("image_urls" in bare.calls[0]!.body!, false);
});

test("past its deadline a request gives up", async () => {
  const { request } = queue({ video: { url: "https://cdn.test/v.mp4" } });
  await assert.rejects(falShot({ prompt: "x", frame: null, deadlineAt: Date.now() - 1, deps: { key: "k", request, pollMs: 1 } }), /timed out/);
});
