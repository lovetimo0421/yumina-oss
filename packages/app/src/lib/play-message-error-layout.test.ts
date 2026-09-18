import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalsCss = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
const messageBubbleSource = readFileSync(
  new URL("../../sandbox/chat/message-bubble.tsx", import.meta.url),
  "utf8",
);
const messageListSource = readFileSync(
  new URL("../../sandbox/chat/message-list.tsx", import.meta.url),
  "utf8",
);

test("failed turns use the reset-resistant chat-surface alert layout", () => {
  assert.match(messageBubbleSource, /className="play-turn-error [^"]*w-full[^"]*min-w-0[^"]*self-stretch/);
  assert.match(messageBubbleSource, /className="play-turn-error__text"/);
  assert.match(messageBubbleSource, /className="play-turn-error__actions /);
  assert.match(messageBubbleSource, /className="play-turn-error__action /);
});

test("the dismissible error banner lets long provider errors shrink and wrap", () => {
  assert.match(messageListSource, /role="alert"/);
  assert.match(messageListSource, /play-message-error flex min-w-0/);
  assert.match(messageListSource, /play-message-error__text min-w-0 flex-1/);
  assert.match(messageListSource, /play-message-error__dismiss shrink-0/);
});

test("platform alert box metrics survive unlayered creator CSS resets", () => {
  assert.match(
    globalsCss,
    /#sandbox-root :is\(\.play-turn-error, \.play-message-error\)\s*\{[\s\S]*?min-width: 0 !important;[\s\S]*?overflow-wrap: anywhere !important;/,
  );
  assert.match(
    globalsCss,
    /#sandbox-root \.play-turn-error\s*\{[\s\S]*?align-self: stretch !important;[\s\S]*?width: 100% !important;[\s\S]*?max-width: 100% !important;[\s\S]*?padding: 0\.667em 1em !important;/,
  );
  assert.match(
    globalsCss,
    /#sandbox-root \.play-message-error\s*\{[\s\S]*?display: flex !important;[\s\S]*?margin-top: 0\.667em !important;[\s\S]*?padding: 0\.667em 1em !important;/,
  );
  assert.doesNotMatch(globalsCss, /#sandbox-root \.play-(?:turn|message)-error[^}]*max-width: 46rem/);
  assert.doesNotMatch(globalsCss, /\.play-(?:turn|message)-error[^}]*?(?:^|[;{]\s*)height\s*:/m);
});
