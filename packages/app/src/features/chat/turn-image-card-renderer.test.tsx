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
