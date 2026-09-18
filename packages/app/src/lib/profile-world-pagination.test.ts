import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shouldResetProfileWorldPage,
  type ProfileWorldQuery,
} from "./profile-world-pagination";

const restoredQuery: ProfileWorldQuery = {
  userId: "user-1",
  search: "dragon",
  pageSize: 12,
  sort: "popular",
  contentLevel: "sensitive",
};

test("restored public-profile pagination survives the initial matching query", () => {
  assert.equal(shouldResetProfileWorldPage(restoredQuery, { ...restoredQuery }), false);
});

test("public-profile pagination resets when the result query changes", () => {
  assert.equal(
    shouldResetProfileWorldPage(restoredQuery, { ...restoredQuery, contentLevel: "safe" }),
    true,
  );
  assert.equal(
    shouldResetProfileWorldPage(restoredQuery, { ...restoredQuery, search: "space" }),
    true,
  );
  assert.equal(
    shouldResetProfileWorldPage(restoredQuery, { ...restoredQuery, sort: "newest" }),
    true,
  );
  assert.equal(
    shouldResetProfileWorldPage(restoredQuery, { ...restoredQuery, userId: "user-2" }),
    true,
  );
  assert.equal(
    shouldResetProfileWorldPage(restoredQuery, { ...restoredQuery, pageSize: 6 }),
    true,
  );
});
