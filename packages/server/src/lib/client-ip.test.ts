import test from "node:test";
import assert from "node:assert/strict";
import { clientIpFrom, isCloudflareAddress, stampClientIp, CLIENT_IP_HEADER } from "./client-ip.js";

const from = (headers: Record<string, string>) => clientIpFrom((name) => headers[name]);

test("a direct request is keyed on the connection, whatever it claims", () => {
  assert.equal(from({ "x-real-ip": "203.0.113.9", "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }), "203.0.113.9");
});

test("a request through Cloudflare is keyed on the visitor Cloudflare names", () => {
  assert.equal(from({ "x-real-ip": "172.68.1.1", "cf-connecting-ip": "198.51.100.7" }), "198.51.100.7");
  assert.equal(from({ "x-real-ip": "2606:4700::1", "cf-connecting-ip": "2001:db8::5" }), "2001:db8::5");
});

test("an edge that already resolved the visitor is taken at its word", () => {
  assert.equal(from({ "x-real-ip": "198.51.100.7", "cf-connecting-ip": "198.51.100.7" }), "198.51.100.7");
});

test("without an edge the old headers still work, and junk is not an address", () => {
  assert.equal(from({ "cf-connecting-ip": "198.51.100.7" }), "198.51.100.7");
  assert.equal(from({ "x-forwarded-for": "198.51.100.8, 10.0.0.1" }), "198.51.100.8");
  assert.equal(from({ "x-real-ip": "not-an-ip", "x-forwarded-for": "<script>" }), null);
  assert.equal(from({}), null);
});

test("Cloudflare ranges", () => {
  assert.equal(isCloudflareAddress("104.16.0.1"), true);
  assert.equal(isCloudflareAddress("162.159.255.255"), true);
  assert.equal(isCloudflareAddress("8.8.8.8"), false);
  assert.equal(isCloudflareAddress("nope"), false);
});

test("the stamped header replaces whatever the sender sent", () => {
  const request = stampClientIp(new Request("http://x/", { headers: { "x-real-ip": "203.0.113.9", [CLIENT_IP_HEADER]: "1.1.1.1" } }));
  assert.equal(request.headers.get(CLIENT_IP_HEADER), "203.0.113.9");
  const none = stampClientIp(new Request("http://x/", { headers: { [CLIENT_IP_HEADER]: "1.1.1.1" } }));
  assert.equal(none.headers.get(CLIENT_IP_HEADER), null);
});
