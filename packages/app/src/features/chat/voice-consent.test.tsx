import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceFundingNotice } from "./voice-consent";
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { readFileSync } from 'node:fs';
await i18next.use(initReactI18next).init({ lng: 'en', resources: { en: { chat: JSON.parse(readFileSync(new URL('../../locales/en/chat.json', import.meta.url), 'utf8')) } }, interpolation: { escapeValue: false } });
test("trusted microphone consent identifies private-pilot platform funding without claiming a saved key", () => {
  const html = renderToStaticMarkup(createElement(VoiceFundingNotice, { funding: "private-pilot" }));
  assert.match(html, /paid by Yumina/); assert.doesNotMatch(html, /saved OpenAI API key/);
  assert.match(renderToStaticMarkup(createElement(VoiceFundingNotice, { funding: "byok" })), /saved OpenAI API key/);
  assert.match(renderToStaticMarkup(createElement(VoiceFundingNotice, { funding: "testing" })), /Testing call included/);
});
test('balance consent distinguishes the actual server temporary reservation from measured charges', () => {
  const html = renderToStaticMarkup(createElement(VoiceFundingNotice, { funding: 'balance', reservationCredits: 75 }));
  assert.match(html, /75/); assert.match(html, /temporary reservation/i); assert.match(html, /measured usage/i);
  assert.doesNotMatch(html, /saved OpenAI|included|paid by Yumina|maximum/i);
});
