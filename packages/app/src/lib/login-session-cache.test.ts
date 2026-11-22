import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guardSource = readFileSync(new URL("./auth-guard.ts", import.meta.url), "utf8");
const loginSource = readFileSync(new URL("../features/auth/login-page.tsx", import.meta.url), "utf8");
const chatStoreSource = readFileSync(new URL("../stores/chat.ts", import.meta.url), "utf8");
const chatViewSource = readFileSync(new URL("../features/chat/chat-view.tsx", import.meta.url), "utf8");

// 2026-10-29 Ivy report: after signing in from a chat link the player bounced
// chat -> /login -> chat because the route guard still held its cached
// "signed out" answer for up to 30s.
test("a completed sign-in forgets the guard's cached session answer", () => {
  assert.match(
    guardSource,
    /export function markLoginComplete\(\) \{[\s\S]*?clearSessionCache\(\);[\s\S]*?\n\}/,
  );
});

test("the login page clears the guard cache before sending a signed-in player back", () => {
  assert.match(
    loginSource,
    /useLayoutEffect\(\(\) => \{\s*if \(session\) \{[\s\S]*?clearSessionCache\(\);[\s\S]*?router\.navigate/,
  );
});

test("a chat the server can't find is tagged so the view offers a way out instead of Retry", () => {
  assert.match(chatStoreSource, /errorCode: res\.status === 404 \? "SESSION_NOT_FOUND" : null/);
  assert.match(chatViewSource, /errorCode === "SESSION_NOT_FOUND"/);
  assert.match(chatViewSource, /returnTo: `\/app\/chat\/\$\{sessionId\}`/);
});
