import assert from "node:assert/strict";
import test from "node:test";
import { validateCustomEndpointUrl } from "./ssrf.js";

test("ssrf: accepts public https URL", () => {
  assert.equal(validateCustomEndpointUrl("https://api.openai.com/v1"), "https://api.openai.com/v1");
});

test("ssrf: accepts public http URL", () => {
  assert.equal(validateCustomEndpointUrl("http://i.orangepie.org/v1"), "http://i.orangepie.org/v1");
});

test("ssrf: normalizes trailing slash", () => {
  assert.equal(validateCustomEndpointUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(validateCustomEndpointUrl("https://api.openai.com/v1///"), "https://api.openai.com/v1");
});

test("ssrf: blocks AWS metadata endpoint", () => {
  assert.throws(() => validateCustomEndpointUrl("http://169.254.169.254/latest/meta-data"));
});

test("ssrf: blocks GCP metadata endpoint", () => {
  assert.throws(() => validateCustomEndpointUrl("http://metadata.google.internal/computeMetadata/v1/"));
  assert.throws(() => validateCustomEndpointUrl("http://metadata/computeMetadata/v1/"));
});

test("ssrf: blocks loopback", () => {
  assert.throws(() => validateCustomEndpointUrl("http://localhost:8080/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://127.0.0.1:8080/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://127.1.2.3/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://[::1]:8080/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://0.0.0.0/v1"));
});

test("ssrf: blocks link-local", () => {
  assert.throws(() => validateCustomEndpointUrl("http://169.254.0.1/v1"));
});

test("ssrf: blocks RFC1918 private ranges", () => {
  assert.throws(() => validateCustomEndpointUrl("http://10.0.0.1/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://10.255.255.255/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://192.168.1.1/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://172.16.0.1/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://172.20.10.5/v1"));
  assert.throws(() => validateCustomEndpointUrl("http://172.31.255.255/v1"));
});

test("ssrf: does NOT block public 172.x addresses outside RFC1918 range", () => {
  // 172.15.x.x and 172.32.x.x are public
  assert.equal(validateCustomEndpointUrl("http://172.15.0.1/v1"), "http://172.15.0.1/v1");
  assert.equal(validateCustomEndpointUrl("http://172.32.0.1/v1"), "http://172.32.0.1/v1");
});

test("ssrf: blocks *.internal and *.local hostnames", () => {
  assert.throws(() => validateCustomEndpointUrl("https://api.internal/v1"));
  assert.throws(() => validateCustomEndpointUrl("https://proxy.local/v1"));
});

test("ssrf: rejects non-http(s) protocols", () => {
  assert.throws(() => validateCustomEndpointUrl("file:///etc/passwd"));
  assert.throws(() => validateCustomEndpointUrl("ftp://example.com/v1"));
  assert.throws(() => validateCustomEndpointUrl("javascript:alert(1)"));
});

test("ssrf: rejects malformed URLs", () => {
  assert.throws(() => validateCustomEndpointUrl("not a url"));
  assert.throws(() => validateCustomEndpointUrl(""));
  assert.throws(() => validateCustomEndpointUrl("http://"));
});

test("ssrf: normalizes hostname case", () => {
  // Hostname is already lowercased for comparison; check real-world behavior
  assert.throws(() => validateCustomEndpointUrl("http://METADATA.GOOGLE.INTERNAL/foo"));
  assert.throws(() => validateCustomEndpointUrl("http://LOCALHOST:8080/v1"));
});

// ─── Address-level guard ────────────────────────────────────────────
import { assertPublicEndpoint, isPrivateAddress } from "./ssrf.js";

test("private, loopback, link-local, CGNAT and ULA addresses are private", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::1]", "not-an-ip"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("a public name that resolves to a private address is refused", async () => {
  await assert.rejects(assertPublicEndpoint("https://127.0.0.1.nip.io/v1", async () => ["127.0.0.1"]), /private network/);
  await assert.rejects(assertPublicEndpoint("https://mixed.example/v1", async () => ["8.8.8.8", "fd00::1"]), /private network/);
  await assert.rejects(assertPublicEndpoint("http://[fd12::1]:8080/v1"), /private network/);
  await assert.doesNotReject(assertPublicEndpoint("https://api.example.com/v1", async () => ["93.184.216.34"]));
  await assert.rejects(assertPublicEndpoint("https://unresolvable.example/v1", async () => { throw new Error("ENOTFOUND"); }), /could not be resolved/);
});

test("the connection itself is refused when the name points inside", async () => {
  const { fetchUserEndpoint } = await import("./ssrf.js");
  // localhost resolves to loopback on every machine; no network is needed.
  await assert.rejects(fetchUserEndpoint("http://localhost:8765/x"), /private network/);
  await assert.rejects(fetchUserEndpoint("http://127.0.0.1:8765/x"), /private network/);
  await assert.rejects(fetchUserEndpoint("http://[::1]:8765/x"), /private network/);
});
