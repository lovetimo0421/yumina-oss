import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getReviewNotificationCopy,
  getStandaloneCommentNotificationCopy,
} from "./review-notification-copy.js";

const locales = ["en", "zh", "zh-Hant", "ja", "es"] as const;

test("rating-only review notifications use the rating copy", () => {
  assert.deepEqual(
    getReviewNotificationCopy({ reviewerName: "Player A", rating: 5 }, "Example Card"),
    {
      key: "notifications.newReview",
      values: { reviewer: "Player A", worldName: "Example Card", rating: 5 },
    },
  );
});

test("review notifications include comment content when present", () => {
  assert.deepEqual(
    getReviewNotificationCopy(
      { reviewerName: "Player B", rating: 5, commentContent: "  This card is great fun  " },
      "Example Card",
    ),
    {
      key: "notifications.newReviewWithComment",
      values: {
        reviewer: "Player B",
        worldName: "Example Card",
        rating: 5,
        comment: "This card is great fun",
      },
    },
  );
});

test("standalone comment notifications show content and retain legacy fallback copy", () => {
  assert.deepEqual(
    getStandaloneCommentNotificationCopy({
      commenterName: "Player C",
      commentContent: "  Standalone feedback  ",
    }, "Example Card"),
    {
      key: "notifications.newReviewCommentOnly",
      values: {
        reviewer: "Player C",
        worldName: "Example Card",
        comment: "Standalone feedback",
      },
    },
  );
  assert.deepEqual(
    getStandaloneCommentNotificationCopy({ commenterName: "Player D" }, "Example Card"),
    {
      key: "notifications.newComment",
      values: { commenter: "Player D", worldName: "Example Card" },
    },
  );
});

test("comment-only reviews remain readable without inventing a star rating", () => {
  assert.equal(
    getReviewNotificationCopy({ reviewerName: "Player C", commentContent: "Nice card" }, "Example Card").key,
    "notifications.newReviewCommentOnly",
  );
});

test("blank or malformed payload fields fall back safely", () => {
  assert.deepEqual(getReviewNotificationCopy({
    reviewerName: "   ",
    rating: Number.NaN,
    commentContent: "   ",
  }, "Example Card"), {
    key: "notifications.newReview",
    values: {
      reviewer: "Someone",
      worldName: "Example Card",
      rating: undefined,
    },
  });
});

test("every locale has interpolation-safe review notification copy", () => {
  const keys = ["newReview", "newReviewWithComment", "newReviewCommentOnly"] as const;
  const expectedPlaceholders = {
    newReview: ["rating", "reviewer", "worldName"],
    newReviewWithComment: ["comment", "rating", "reviewer", "worldName"],
    newReviewCommentOnly: ["comment", "reviewer", "worldName"],
  };

  for (const locale of locales) {
    const file = new URL(`../locales/${locale}/common.json`, import.meta.url);
    const common = JSON.parse(readFileSync(file, "utf8")) as {
      notifications?: Record<string, string>;
    };
    for (const key of keys) {
      const value = common.notifications?.[key];
      assert.ok(value?.trim(), `${locale}: notifications.${key} must exist`);
      const placeholders = [...value!.matchAll(/\{\{([^}]+)\}\}/g)]
        .map((match) => match[1]!)
        .sort();
      assert.deepEqual(placeholders, expectedPlaceholders[key], `${locale}: notifications.${key}`);
    }
  }
});
