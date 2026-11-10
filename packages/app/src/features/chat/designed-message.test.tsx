import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { UiMessageRule } from "@yumina/engine";

// The message layer's renderer lives in the sandbox (sandbox/chat/
// designed-message.tsx) and is imported by the Studio preview too; this drives
// it the way the transcript does, over the real sanitising markdown pipeline.

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: "http://localhost" });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
  DocumentFragment: dom.window.DocumentFragment, IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { DesignedMessage, __resetRevealMemory } = await import("@/../sandbox/chat/designed-message");
const { renderMessage } = await import("@/../sandbox/chat/markdown");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const thought: UiMessageRule = { id: "thought", name: "心里话", match: { kind: "wrap", open: "♡", close: "♡" }, show: "reveal", options: { cover: "ink" } };
const banner: UiMessageRule = { id: "banner", name: "横幅", match: { kind: "wrap", open: "【", close: "】" }, show: "banner" };
const choices: UiMessageRule = { id: "choices", name: "选项", match: { kind: "line-prefix", prefix: "※" }, show: "choices" };
const speaker: UiMessageRule = { id: "speaker", name: "说话人", match: { kind: "regex", pattern: "^([^：:]{1,10})[：:]\\s*(.+)$" }, show: "speaker" };

/** A storage that behaves like the host's: async, string values, per key. */
function makeHost() {
  const store = new Map<string, string>();
  const sent: string[] = [];
  return {
    store,
    sent,
    host: {
      sendMessage: (text: string) => { sent.push(text); },
      resolveAssetUrl: (ref: string) => ref,
      storage: {
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: string) => { store.set(key, value); },
      },
      canSend: () => true,
    },
  };
}

type Props = Parameters<typeof DesignedMessage>[0];
async function mount(props: Omit<Props, "renderMarkdown">) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(DesignedMessage, { ...props, renderMarkdown: renderMessage })));
  // Let the async memory read land.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el: host, unmount: () => act(async () => root.unmount()) };
}
const click = (el: Element | null | undefined) => act(async () => {
  assert.ok(el, "element to click");
  el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
});

test("a covered thought reveals on tap and remembers it per message and swipe", async () => {
  __resetRevealMemory();
  const { host, store } = makeHost();
  const base = { design: { rules: [thought] }, host, content: "她笑了。♡其实很开心♡", role: "assistant" as const, messageId: "m1", swipeIndex: 0 };

  const first = await mount(base);
  const cover = first.el.querySelector(".yc-reveal--ink");
  assert.ok(cover, "the thought starts covered");
  await click(cover);
  assert.ok(first.el.querySelector(".yc-reveal--open"), "a tap reveals it");
  assert.match(first.el.querySelector(".yc-reveal--open")!.textContent ?? "", /其实很开心/);
  assert.deepEqual(JSON.parse(store.get("yc-reveal:m1")!), { "0:thought:0": "r" });
  await first.unmount();

  // A fresh page (memory gone) reads it back from storage.
  __resetRevealMemory();
  const again = await mount(base);
  assert.ok(again.el.querySelector(".yc-reveal--open"), "revealed state survives a reload");
  await again.unmount();

  // Another swipe of the same message is a different text with its own secret.
  const otherSwipe = await mount({ ...base, swipeIndex: 1 });
  assert.ok(otherSwipe.el.querySelector(".yc-reveal--ink"), "a regenerated version starts covered");
  await otherSwipe.unmount();
});

test("a reveal that misses says so, and the miss is remembered", async () => {
  __resetRevealMemory();
  const { host, store } = makeHost();
  const risky = { ...thought, options: { cover: "blur" as const, revealChance: 0, missText: "看不透" } };
  const m = await mount({ design: { rules: [risky] }, host, content: "♡秘密♡", role: "assistant", messageId: "m2" });
  await click(m.el.querySelector(".yc-reveal--blur"));
  assert.equal(m.el.querySelector(".yc-reveal--missed")?.textContent, "看不透");
  assert.equal(m.el.textContent?.includes("秘密"), false, "the secret stays hidden");
  assert.deepEqual(JSON.parse(store.get("yc-reveal:m2")!), { "0:thought:0": "m" });
  await m.unmount();
});

test("choice lines become buttons that send themselves, on the newest reply only", async () => {
  __resetRevealMemory();
  const { host, sent } = makeHost();
  const content = "要怎么做？\n※ 跟上去\n※ 先回家";
  const live = await mount({ design: { rules: [choices] }, host, content, role: "assistant", messageId: "m3", isLastMessage: true });
  const buttons = [...live.el.querySelectorAll("button.yc-msg-choice")];
  assert.deepEqual(buttons.map((b) => b.textContent?.replace("›", "").trim()), ["跟上去", "先回家"]);
  await click(buttons[1]);
  assert.deepEqual(sent, ["先回家"]);
  await click(buttons[0]);
  assert.deepEqual(sent, ["先回家"], "a second tap sends nothing");
  assert.ok(buttons.every((b) => (b as HTMLButtonElement).disabled));
  await live.unmount();

  const old = await mount({ design: { rules: [choices] }, host, content, role: "assistant", messageId: "m3", isLastMessage: false });
  assert.equal(old.el.querySelectorAll("button.yc-msg-choice").length, 0, "older replies do not offer choices");
  assert.match(old.el.textContent ?? "", /要怎么做/);
  await old.unmount();

  const streaming = await mount({ design: { rules: [choices] }, host, content, role: "assistant", isLastMessage: true, isStreaming: true });
  assert.equal(streaming.el.querySelectorAll("button.yc-msg-choice").length, 0, "no choices while the reply streams");
  await streaming.unmount();
});

test("banners, speakers and cards draw model text as text, never as markup", async () => {
  __resetRevealMemory();
  const { host } = makeHost();
  const evil = '<img src=x onerror="window.__pwned=1">';
  const card: UiMessageRule = { id: "card", name: "广播", match: { kind: "contains", text: "【广播】" }, show: "card", options: { title: "📻 广播" } };
  const m = await mount({
    design: { rules: [card, banner, speaker, thought] },
    host,
    content: `【广播】\n【${evil}】\n艾拉：${evil}♡${evil}♡\n正文 ${evil}`,
    role: "assistant",
    messageId: "m4",
  });
  assert.equal(m.el.querySelectorAll("img").length, 0, "no element was made from model text");
  assert.equal(m.el.querySelector(".yc-msg-card-title")?.textContent, "📻 广播");
  assert.match(m.el.querySelector(".yc-msg-banner-text")?.textContent ?? "", /<img/);
  assert.equal(m.el.querySelector(".yc-msg-speaker-name")?.textContent, "艾拉");
  await m.unmount();
});

test("message style paints the side it is for, and a plain message keeps the stock path", async () => {
  __resetRevealMemory();
  const { host } = makeHost();
  const design = {
    style: {
      assistant: { bubble: true, box: { fills: [{ kind: "color" as const, color: "rgb(1, 2, 3)" }], padding: 10 }, text: { size: 17 } },
      user: { bubble: false, text: { italic: true } },
    },
    rules: [thought],
  };
  const ai = await mount({ design, host, content: "你好", role: "assistant" });
  const aiBox = ai.el.querySelector(".yc-msg") as HTMLElement;
  assert.equal(aiBox.style.background, "rgb(1, 2, 3)");
  assert.equal(aiBox.style.fontSize, "17px");
  assert.ok(ai.el.querySelector(".yc-msg-prose"), "an untouched message renders through the stock markdown path");
  await ai.unmount();

  const me = await mount({ design, host, content: "♡不套用♡", role: "user" });
  const meBox = me.el.querySelector(".yc-msg") as HTMLElement;
  assert.equal(meBox.style.fontStyle, "italic");
  assert.equal(me.el.querySelector(".yc-reveal"), null, "rules skip the player's lines unless asked");
  await me.unmount();
});

test("each message style preset draws both sides its own way", async () => {
  __resetRevealMemory();
  const { MESSAGE_STYLE_PRESETS } = await import("@yumina/engine");
  const { host } = makeHost();
  const seen = new Set<string>();
  for (const [id, style] of Object.entries(MESSAGE_STYLE_PRESETS)) {
    for (const role of ["assistant", "user"] as const) {
      const side = role === "user" ? style.user : style.assistant;
      const m = await mount({ design: { style, rules: [] }, host, content: "雨停了。", role });
      const box = m.el.querySelector(".yc-msg") as HTMLElement;
      assert.ok(box, `${id}/${role} renders`);
      assert.equal(box.classList.contains("yc-msg--bubble"), !!side?.bubble, `${id}/${role} bubble`);
      if (!side?.bubble) assert.equal(box.style.background, "", `${id}/${role}: no surface of its own`);
      else assert.notEqual(box.style.background, "", `${id}/${role}: a surface of its own`);
      seen.add(`${role}:${box.getAttribute("style")}`);
      await m.unmount();
    }
  }
  // Four presets × two sides, all different from each other.
  assert.equal(seen.size, Object.keys(MESSAGE_STYLE_PRESETS).length * 2);
});
