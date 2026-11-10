import assert from "node:assert/strict";
import test from "node:test";
import { historyCacheBreakpoint } from "./history-cache-breakpoint.js";

type Msg = { role: string; content: string };
const msg = (content: string, role = "user"): Msg => ({ role, content });

test("no injected entries: keeps the offset estimate", () => {
  const chat = [msg("sys", "system"), msg("a"), msg("b"), msg("c")];
  assert.equal(historyCacheBreakpoint(chat, new Set(), 2), 2);
});

test("several entries at one depth: breaks before the block, not inside it", () => {
  const e1 = msg("lore 1", "system");
  const e2 = msg("lore 2", "system");
  const e3 = msg("lore 3", "system");
  // [sys, h1..h4, e1, e2, e3, h5..h8, format]
  const chat = [msg("sys", "system"), msg("h1"), msg("h2"), msg("h3"), msg("h4"), e1, e2, e3, msg("h5"), msg("h6"), msg("h7"), msg("h8"), msg("fmt", "system")];
  // The old estimate (end - suffix - (depth 4 + 1)) lands on e2.
  const estimate = chat.length - 1 - 1 - 5;
  assert.equal(chat[estimate], e2);
  assert.equal(historyCacheBreakpoint(chat, new Set([e1, e2, e3]), estimate), 4);
});

test("the cached prefix survives the next turn's shifted entry block", () => {
  const lore = () => msg("lore", "system");
  const h = Array.from({ length: 12 }, (_, i) => msg(`h${i}`));
  const turn = (historyLen: number) => {
    const entries = [lore(), lore()];
    const history = h.slice(0, historyLen);
    const at = history.length - 4;
    const chat = [msg("sys", "system"), ...history.slice(0, at), ...entries, ...history.slice(at)];
    return { chat, bp: historyCacheBreakpoint(chat, new Set(entries), chat.length - 1 - 5) };
  };
  const a = turn(8);
  const b = turn(10);
  const prefix = a.chat.slice(0, a.bp + 1).map((m) => m.content);
  assert.deepEqual(b.chat.slice(0, a.bp + 1).map((m) => m.content), prefix);
});

test("entries trimmed out of the window fall back to the estimate", () => {
  const chat = [msg("sys", "system"), msg("a"), msg("b")];
  assert.equal(historyCacheBreakpoint(chat, new Set([msg("gone", "system")]), 1), 1);
});
