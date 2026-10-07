import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JobAsk } from "./agent-job-chat";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { editor: { studio: { job: {
  ask: "About {{minutes}} min · {{mushies}} mushies",
  askByKey: "About {{minutes}} min · your own key",
  start: "Start",
} } } } } });

const render = (interactive: boolean) => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
  createElement(JobAsk, { plan: ["Write the sect", "Add cultivation numbers"], minutes: 9, mushies: 56, interactive, onStart: () => {} })));

// A reply with no words of its own showed only 「9 分钟 · 开始」: the plan has to
// be on the page before Start, not behind a button.
test("a big job shows its plan before Start", () => {
  const html = render(true);
  assert.match(html, /Write the sect/);
  assert.match(html, /Add cultivation numbers/);
  assert.ok(html.indexOf("Write the sect") < html.indexOf("Start"), "the plan reads before the button");
});

test("a started or older proposal keeps its plan and loses the button", () => {
  const html = render(false);
  assert.match(html, /Write the sect/);
  assert.doesNotMatch(html, />Start</);
});
