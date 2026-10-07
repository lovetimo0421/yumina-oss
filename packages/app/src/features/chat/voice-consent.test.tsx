import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceFundingNotice } from "./voice-consent";
test("trusted microphone consent identifies private-pilot platform funding without claiming a saved key", () => {
  const html = renderToStaticMarkup(createElement(VoiceFundingNotice, { funding: "private-pilot" }));
  assert.match(html, /paid by Yumina/); assert.doesNotMatch(html, /saved OpenAI API key/);
  assert.match(renderToStaticMarkup(createElement(VoiceFundingNotice, { funding: "byok" })), /saved OpenAI API key/);
  assert.match(renderToStaticMarkup(createElement(VoiceFundingNotice, { funding: "testing" })), /Testing call included/);
});
