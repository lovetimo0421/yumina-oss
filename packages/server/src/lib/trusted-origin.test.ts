import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedRequestOrigin } from "./trusted-origin.js";

const configured = ["https://yumina.io", "https://yumina-testing.io"];
const h = (init: Record<string, string>) => new Headers(init);

test("no Origin header is treated as same-origin", () => {
  assert.equal(isTrustedRequestOrigin(undefined, "http://internal:8080/api/x", h({}), configured), true);
});

test("behind the proxy, the forwarded host is the browser's origin", () => {
  const headers = h({ host: "internal:8080", "x-forwarded-host": "preview.example.test", "x-forwarded-proto": "https" });
  assert.equal(
    isTrustedRequestOrigin("https://preview.example.test", "http://internal:8080/api/engagement/browse", headers, configured),
    true,
  );
});

test("configured origins are trusted even when the request URL is internal", () => {
  const headers = h({ host: "internal:8080" });
  assert.equal(isTrustedRequestOrigin("https://yumina-testing.io", "http://internal:8080/api/x", headers, configured), true);
});

test("origin matching the direct request URL is trusted (local dev)", () => {
  assert.equal(isTrustedRequestOrigin("http://localhost:3223", "http://localhost:3223/api/x", h({ host: "localhost:3223" }), []), true);
});

test("a foreign origin is rejected", () => {
  const headers = h({ host: "yumina.io", "x-forwarded-proto": "https" });
  assert.equal(isTrustedRequestOrigin("https://evil.example", "http://internal:8080/api/x", headers, configured), false);
  assert.equal(isTrustedRequestOrigin("null", "http://internal:8080/api/x", headers, configured), false);
});

test("scheme mismatch with the forwarded proto is rejected", () => {
  const headers = h({ host: "internal:8080", "x-forwarded-host": "preview.example", "x-forwarded-proto": "https" });
  assert.equal(isTrustedRequestOrigin("http://preview.example", "http://internal:8080/api/x", headers, []), false);
});
