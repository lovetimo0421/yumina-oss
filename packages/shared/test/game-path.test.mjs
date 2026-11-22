import assert from "node:assert/strict";
import test from "node:test";
import { isFirstPartyGamePath, foreignGamePath } from "../dist/index.js";

test("only the platform's own game pages pass", () => {
  for (const path of ["/pvz/", "/pvz", "/pvz/?join=AB12", "/krew", "/krew/", "/experiments/unperson/", "/pvz/index.html#x"]) {
    assert.equal(isFirstPartyGamePath(path), true, path);
  }
  for (const path of [
    "/cdn/key/abc", "/cdn/123", "/api/users/me", "//evil.example/pvz/", "/\evil.example/x", "https://evil.example/pvz/",
    "/pvz/../cdn/key/abc", "/pvz/./../cdn/x", "/pvz/%2e%2e/cdn/x", "/pvz/.\t./cdn/x", "/pvz/\n../cdn", " /pvz/", "/pvzx/", "/krewmate",
    "pvz/", "", null, undefined, 42, {},
  ]) assert.equal(isFirstPartyGamePath(path), false, String(path));
});

test("a card schema is flagged only when it names a page that is not ours", () => {
  assert.equal(foreignGamePath({ game: { path: "/pvz/" } }), null);
  assert.equal(foreignGamePath({}), null);
  assert.equal(foreignGamePath({ game: { web: { asset: "@asset:x" } } }), null);
  assert.equal(foreignGamePath({ game: { path: "/cdn/key/abc" } }), "/cdn/key/abc");
  assert.equal(foreignGamePath({ game: { path: 7 } }), "7");
});
