import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_CREATOR_TIP_DOWNLOADS,
  MIN_CREATOR_TIP_MESSAGES,
  creatorMeetsTipThreshold,
} from "./tip-eligibility.js";

// A creator can receive MUSHIE GIFTS once their works, in aggregate, clear both
// a download and an interaction floor. The floors are a low spam bar, not the
// anti-farm defense — that lives on the sender side (free-tier-gift-cap.ts).
// Money tips are not gated at all.

test("the thresholds are the agreed 10 downloads and 100 messages", () => {
  assert.equal(MIN_CREATOR_TIP_DOWNLOADS, 10);
  assert.equal(MIN_CREATOR_TIP_MESSAGES, 100);
});

test("a creator exactly at both floors is eligible", () => {
  assert.equal(creatorMeetsTipThreshold(10, 100), true);
});

test("one download short fails however many messages there are", () => {
  assert.equal(creatorMeetsTipThreshold(9, 1_000_000), false);
});

test("one message short fails however many downloads there are", () => {
  assert.equal(creatorMeetsTipThreshold(1_000_000, 99), false);
});

test("both axes are required, not either", () => {
  assert.equal(creatorMeetsTipThreshold(10_000, 0), false);
  assert.equal(creatorMeetsTipThreshold(0, 10_000), false);
  assert.equal(creatorMeetsTipThreshold(0, 0), false);
});

test("negative or non-finite aggregates can never pass", () => {
  assert.equal(creatorMeetsTipThreshold(Number.NaN, Number.NaN), false);
  assert.equal(creatorMeetsTipThreshold(-10, -100), false);
  assert.equal(creatorMeetsTipThreshold(10, Number.NaN), false);
});
