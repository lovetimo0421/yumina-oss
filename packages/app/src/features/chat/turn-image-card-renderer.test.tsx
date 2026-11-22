import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SandboxMessage } from "../../../sandbox/chat/types";

const key = Buffer.from("users/u1/turn-images/abc.jpg").toString("base64url");
const reply = `你再度闭合双眼。\n\n【去向】\n- 走生门路\n- 独行归庐\n\n[image:/cdn/key/${key}|alt=scene]`;

// 问道's bubble: text before 【去向】 is the body, lines after it are choices,
// and anything over 60 characters is dropped — the picture line included.
function WendaoBubble(props: Record<string, unknown>) {
  const raw = props.rawContent as string;
  const at = raw.lastIndexOf("【去向】");
  const choices = raw.slice(at + 4).split("\n").map((l) => l.replace(/^- /, "").trim()).filter((l) => l && l.length <= 60);
  return (
    <div className="wendao">
      <p>{raw.slice(0, at).trim()}</p>
      {choices.map((c) => <button key={c}>{c}</button>)}
    </div>
  );
}

test("a card that slices the reply itself still shows the per-turn picture, once, below its bubble", async () => {
  // The markdown renderer sanitizes with DOMPurify, which binds to `window` on import.
  const dom = new JSDOM("", { url: "http://localhost" });
  // tsx compiles files outside tsconfig.app.json's `include` (the sandbox) with the classic JSX runtime.
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, React });
  const { MessageBubble } = await import("../../../sandbox/chat/message-bubble");

  const message: SandboxMessage = { id: "m1", sessionId: "s1", role: "assistant", content: reply, createdAt: "2026-09-29T00:00:00Z" };
  const html = renderToStaticMarkup(<MessageBubble message={message} rendererComponent={WendaoBubble} />);
  assert.equal(html.match(/<img /g)?.length, 1);
  assert.match(html, new RegExp(`/cdn/key/${key}`));
  assert.ok(html.indexOf("wendao") < html.indexOf("<img "), "picture sits under the card's bubble");
  assert.deepEqual([...html.matchAll(/<button>([^<]*)<\/button>/g)].map((m) => m[1]), ["走生门路", "独行归庐"]);
});

test("a redrawn picture shows a small ‹ n/N › stepper where the pick can be saved, and none for one picture", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, React });
  const { TurnImageCard } = await import("../../../sandbox/chat/turn-image-card");
  const { makeChatT } = await import("../../../sandbox/chat/i18n");
  const k = (name: string) => Buffer.from(`users/u1/turn-images/${name}.jpg`).toString("base64url");
  const t = makeChatT("en");
  const owner = { mode: "session", readOnly: false, capabilities: {}, messages: [], getTurnImageSettings: async () => null } as never;
  const viewer = { mode: "replay", readOnly: true, capabilities: {}, messages: [], getTurnImageSettings: async () => null } as never;
  const message: SandboxMessage = { id: "m1", sessionId: "s1", role: "assistant", content: "", createdAt: "2026-11-08T00:00:00Z" };
  const picked = `[image:/cdn/key/${k("b")}|alt=scene|versions=${k("a")},${k("b")},${k("c")}]`;

  const html = renderToStaticMarkup(<TurnImageCard embed={picked} message={message} api={owner} t={t} />);
  assert.match(html, />2\/3</);
  assert.match(html, new RegExp(`/cdn/key/${k("b")}`), "the picked version is the one shown");
  assert.doesNotMatch(html, new RegExp(`/cdn/key/${k("a")}`));
  assert.match(html, /aria-label="Previous picture"/);
  assert.match(html, /aria-label="Next picture"/);

  // At the newest one, "next" is off.
  const newest = renderToStaticMarkup(<TurnImageCard embed={picked.replace(`/cdn/key/${k("b")}`, `/cdn/key/${k("c")}`)} message={message} api={owner} t={t} />);
  assert.match(newest, />3\/3</);
  assert.match(newest, /disabled=""[^>]*aria-label="Next picture"/);

  // One picture (every reply drawn before versions existed): no stepper.
  const single = renderToStaticMarkup(<TurnImageCard embed={`[image:/cdn/key/${k("a")}|alt=scene]`} message={message} api={owner} t={t} />);
  assert.doesNotMatch(single, /Previous picture/);
  // Someone else's chat (a replay) shows the picked one, without a stepper.
  const replay = renderToStaticMarkup(<TurnImageCard embed={picked} message={message} api={viewer} t={t} />);
  assert.doesNotMatch(replay, /Previous picture/);
  assert.match(replay, new RegExp(`/cdn/key/${k("b")}`));
  // While a redraw is drawing, nothing to step.
  const drawing = renderToStaticMarkup(<TurnImageCard embed={picked} message={{ ...message, turnImage: { status: "drawing" } } as SandboxMessage} api={owner} t={t} />);
  assert.doesNotMatch(drawing, /Previous picture/);
});
