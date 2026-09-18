import assert from "node:assert/strict";
import test from "node:test";
import { slimMessages } from "./slim-messages";

const msg = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  role: "assistant",
  content: "active body",
  stateSnapshot: { variables: { hp: 10 } }, // message-level — must survive
  activeSwipeIndex: 1,
  swipes: [
    { content: "swipe0", rawContent: "raw0", stateSnapshot: { variables: { hp: 9 } }, model: "x", creditCost: 1 },
    { content: "swipe1", rawContent: "raw1", stateSnapshot: { variables: { hp: 10 } }, model: "x", creditCost: 2 },
    { content: "swipe2", rawContent: "raw2", stateSnapshot: { variables: { hp: 11 } }, model: "x", creditCost: 3 },
  ],
  ...over,
});

test("slimMessages keeps message-level stateSnapshot (renderers + compacted display read it)", () => {
  const [out] = slimMessages([msg()]);
  assert.deepEqual(out.stateSnapshot, { variables: { hp: 10 } });
});

test("slimMessages drops swipe-level stateSnapshot from every swipe", () => {
  const [out] = slimMessages([msg()]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  for (const s of swipes) assert.equal("stateSnapshot" in s, false);
});

test("slimMessages keeps the active swipe's content + rawContent, drops them on non-active swipes", () => {
  const [out] = slimMessages([msg({ activeSwipeIndex: 1 })]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  // active (index 1) keeps content + rawContent
  assert.equal(swipes[1]!.content, "swipe1");
  assert.equal(swipes[1]!.rawContent, "raw1");
  // non-active drop content + rawContent
  assert.equal("content" in swipes[0]!, false);
  assert.equal("rawContent" in swipes[0]!, false);
  assert.equal("content" in swipes[2]!, false);
  assert.equal("rawContent" in swipes[2]!, false);
});

test("slimMessages preserves swipe count + scalar fields (for the N/M control)", () => {
  const [out] = slimMessages([msg()]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  assert.equal(swipes.length, 3); // count drives "2/3"
  assert.equal(swipes[0]!.model, "x"); // scalars kept
  assert.equal(swipes[0]!.creditCost, 1);
});

test("slimMessages defaults activeSwipeIndex to 0 when absent", () => {
  const m = msg({ activeSwipeIndex: undefined });
  delete (m as Record<string, unknown>).activeSwipeIndex;
  const [out] = slimMessages([m]);
  const swipes = out.swipes as Array<Record<string, unknown>>;
  assert.equal(swipes[0]!.content, "swipe0"); // index 0 treated as active
  assert.equal("content" in swipes[1]!, false);
});

test("slimMessages returns the SAME array ref when no message has swipes (memo stability)", () => {
  const input = [{ id: "u1", role: "user", content: "hi" }];
  assert.equal(slimMessages(input), input);
});

test("slimMessages leaves a swipe-free message object untouched", () => {
  const input = [{ id: "u1", role: "user", content: "hi", stateSnapshot: { variables: {} } }];
  const [out] = slimMessages(input);
  assert.equal(out, input[0]); // same ref
});
