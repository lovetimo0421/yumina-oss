import assert from "node:assert/strict";
import test from "node:test";
import { localSetupRoutes, renderScript, requestOrigin } from "./local-setup.js";

const headers = (h: Record<string, string>) => new Headers(h);

test("the origin comes from the host the script was fetched from", () => {
  assert.equal(requestOrigin(headers({ host: "yumina.io", "x-forwarded-proto": "https" }), "http"), "https://yumina.io");
  assert.equal(requestOrigin(headers({ host: "127.0.0.1:5173" }), "http"), "http://127.0.0.1:5173");
  assert.equal(requestOrigin(headers({ host: "internal:8080", "x-forwarded-host": "yumina.io", "x-forwarded-proto": "https" }), "http"), "https://yumina.io");
});

test("a host that could break out of the script's string is refused", () => {
  assert.equal(requestOrigin(headers({ host: "evil.com'; iex x; '" }), "https"), null);
  assert.equal(requestOrigin(headers({ host: "a.com/x" }), "https"), null);
  assert.equal(requestOrigin(headers({ host: "a.com\"$(rm -rf ~)\"" }), "https"), null);
});

test("an unknown proto falls back instead of being echoed", () => {
  assert.equal(requestOrigin(headers({ host: "yumina.io", "x-forwarded-proto": "javascript" }), "https"), "https://yumina.io");
});

test("rendering fills origin and language and nothing else", () => {
  const out = renderScript("o='__ORIGIN__' l='__LANG__' o2=__ORIGIN__", "https://yumina.io", "fr");
  assert.equal(out, "o='https://yumina.io' l='en' o2=https://yumina.io");
  assert.equal(renderScript("__LANG__", "x", "zh"), "zh");
});

test("mode is either allow or setup, never echoed", () => {
  assert.equal(renderScript("m=__MODE__", "x", "zh", "allow"), "m=allow");
  assert.equal(renderScript("m=__MODE__", "x", "zh", "'; rm -rf ~"), "m=setup");
  assert.equal(renderScript("m=__MODE__", "x", "zh"), "m=setup");
});

test("both scripts are served as plain text with the requesting origin baked in", async () => {
  for (const [name, marker] of [["setup.ps1", "$YuminaOrigin = 'https://yumina.io'"], ["setup.sh", "YUMINA_ORIGIN='https://yumina.io'"]] as const) {
    const res = await localSetupRoutes.request(`/${name}?lang=zh`, { headers: { host: "yumina.io", "x-forwarded-proto": "https" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const body = await res.text();
    assert.ok(body.includes(marker), `${name} carries the origin`);
    assert.ok(!body.includes("__ORIGIN__") && !body.includes("__LANG__") && !body.includes("__MODE__"), `${name} has no placeholders left`);
    assert.ok(!body.includes("\r\n"), `${name} is LF-only`);
  }
});
