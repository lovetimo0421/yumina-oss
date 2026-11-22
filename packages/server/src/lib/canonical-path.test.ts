import test from "node:test";
import assert from "node:assert/strict";
import { isCanonicalPath } from "./canonical-path.js";

test("ordinary paths pass", () => {
  for (const path of ["/", "/sandbox/index.html", "/api/worlds/abc", "/cdn/key/d29ybGRz_-x/cover-preview", "/api/models/openai%2Fgpt-5", "/assets/a.b.js", "/.well-known/x", "/app/chat/..x"]) {
    assert.equal(isCanonicalPath(path), true, path);
  }
});

test("spellings the file server would quietly resolve are refused", () => {
  for (const path of ["//sandbox/index.html", "/sandbox//index.html", "/./sandbox/index.html", "/a/../sandbox/index.html", "/%2e/sandbox/index.html", "/%2E%2E/x", "/sandbox" + String.fromCharCode(92) + "index.html","/%5csandbox/index.html", "/sandbox/.", "/.."]) {
    assert.equal(isCanonicalPath(path), false, path);
  }
});
