import test from "node:test";
import assert from "node:assert/strict";
import { resolveNetworkConfig } from "./network-config.js";

test("a port change updates public, auth and sandbox addresses together", () => {
  const config = resolveNetworkConfig({ port: 3088, publicHost: "192.168.137.1", localEdition: true });
  assert.equal(config.publicOrigin, "http://192.168.137.1:3088");
  assert.equal(config.authUrl, config.publicOrigin);
  assert.equal(config.sandboxHttpSource, " http://192.168.137.1:3088");
  assert.equal(config.secureCookies, false);
});
test("an HTTPS reverse proxy can use a different public port", () => {
  const config = resolveNetworkConfig({ port: 3088, publicOrigin: "https://play.example.com/", localEdition: true });
  assert.equal(config.authUrl, "https://play.example.com");
  assert.equal(config.secureCookies, true);
  assert.equal(config.sandboxHttpSource, "");
});
test("legacy auth URL remains usable and explicit URLs retain precedence", () => {
  const legacy = resolveNetworkConfig({ port: 3088, authUrl: "http://old.example:8080", localEdition: true });
  assert.equal(legacy.publicOrigin, "http://old.example:8080");
  const config = resolveNetworkConfig({ port: 3088, publicHost: "ignored", publicOrigin: "https://play.example.com", authUrl: "https://auth.example.com", localEdition: true });
  assert.equal(config.publicOrigin, "https://play.example.com");
  assert.equal(config.authUrl, "https://auth.example.com");
});
test("hosted mode never enables insecure cookies or HTTP sandbox sources", () => {
  const config = resolveNetworkConfig({ port: 3088, publicHost: "localhost", localEdition: false });
  assert.equal(config.secureCookies, true);
  assert.equal(config.sandboxHttpSource, "");
});
test("invalid addresses and ports cannot turn into CSP sources", () => {
  for (const publicOrigin of ["file:///tmp", "http://user:pass@example.com", "http://example.com/path", "http://example.com/?x=1"]) {
    assert.throws(() => resolveNetworkConfig({ port: 3088, publicOrigin, localEdition: true }));
  }
  for (const port of [0, 65536, 1.5, NaN]) assert.throws(() => resolveNetworkConfig({ port, localEdition: true }));
});
