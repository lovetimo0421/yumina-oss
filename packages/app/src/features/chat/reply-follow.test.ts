import assert from "node:assert/strict";
import test from "node:test";
import { followReplyStep } from "../../../sandbox/chat/reply-follow";
import { waitStage } from "../../../sandbox/chat/reply-waiting";

// Launch QA: when a reply finished, only its speaker label was in view (the
// list had parked at the player's own line). The follow shows as much of the
// reply as fits, but never scrolls its first line off the top.
function viewport(scrollTop: number, clientHeight: number, scrollHeight: number) {
  const el = {
    scrollTop, clientHeight, scrollHeight, offsetHeight: clientHeight,
    getBoundingClientRect: () => ({ top: 0, height: clientHeight }),
  };
  return el as unknown as HTMLElement & { scrollTop: number };
}
const replyAt = (el: { scrollTop: number }, contentTop: number) =>
  ({ getBoundingClientRect: () => ({ top: contentTop - el.scrollTop }) }) as unknown as HTMLElement;
const setTop = (el: HTMLElement, top: number) => { (el as { scrollTop: number }).scrollTop = top; };

test("a short reply is followed to the bottom", () => {
  const el = viewport(1000, 800, 2100);
  followReplyStep(el, replyAt(el, 1700), setTop);
  assert.equal(el.scrollTop, 1300);
});

test("a long reply stops with its start at the top", () => {
  const el = viewport(1000, 800, 4000);
  followReplyStep(el, replyAt(el, 1700), setTop);
  assert.equal(el.scrollTop, 1688);
});

test("the follow never scrolls up against the reader", () => {
  const el = viewport(2500, 800, 4000);
  followReplyStep(el, replyAt(el, 1700), setTop);
  assert.equal(el.scrollTop, 2500);
});

test("the wait before the first token says more the longer it lasts", () => {
  assert.equal(waitStage(0), "dots");
  assert.equal(waitStage(4_999), "dots");
  assert.equal(waitStage(5_000), "thinking");
  assert.equal(waitStage(19_999), "thinking");
  assert.equal(waitStage(45_000), "heavy");
});

test("settling a finished reply may move back up to its start (scroll anchoring threw it to the bottom)", () => {
  const el = viewport(3400, 741, 4141);
  followReplyStep(el, replyAt(el, 1963), setTop);
  assert.equal(el.scrollTop, 3400, "never up while following");
  followReplyStep(el, replyAt(el, 1963), setTop, true);
  assert.equal(el.scrollTop, 1951);
});
