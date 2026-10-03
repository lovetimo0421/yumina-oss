// krew's engine page derives its gateway from its own host (`game.` + host
// minus `play.`/`www.`). The preconnect hint in /krew's initial HTML must
// name the same host, or it warms a connection nobody uses.
import assert from "node:assert/strict";
import test from "node:test";
import { krewGameOrigin } from "../dist/index.js";

test("gateway origin follows krew's own host rule", () => {
  assert.equal(krewGameOrigin("https://play.krew.io"), "https://game.krew.io");
  assert.equal(krewGameOrigin("https://www.krew.io/"), "https://game.krew.io");
  assert.equal(krewGameOrigin("https://test.krew.io"), "https://game.test.krew.io");
  assert.equal(krewGameOrigin("https://krew.io"), "https://game.krew.io");
});

test("gateway origin is null when there is nothing safe to warm", () => {
  assert.equal(krewGameOrigin(""), null);
  assert.equal(krewGameOrigin("not a url"), null);
  assert.equal(krewGameOrigin("javascript:alert(1)"), null);
  assert.equal(krewGameOrigin("http://localhost:5173"), null);
  assert.equal(krewGameOrigin("http://127.0.0.1:5173"), null);
});
