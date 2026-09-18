import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chatSource = readFileSync(new URL("../stores/chat.ts", import.meta.url), "utf8");

test("session loads route HTTP 401 through the central auth-loss handler", () => {
  assert.match(
    chatSource,
    /if \(res\.status === 401\) \{\s*set\(\{ error: null \}\);\s*handleAuthLoss\(\);\s*return;/,
  );
});

test("all chat streaming actions recover auth instead of displaying Unauthorized", () => {
  const authBranches = chatSource.match(
    /meta\?\.origin === "http" && meta\.status === 401/g,
  );
  assert.equal(authBranches?.length, 3, "send, regenerate, and continue must all handle HTTP 401");
  assert.match(chatSource, /finishChatAuthLoss\(set, \{ dropPendingMessage: true \}\)/);
});
