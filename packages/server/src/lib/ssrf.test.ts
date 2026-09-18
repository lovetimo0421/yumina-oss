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
