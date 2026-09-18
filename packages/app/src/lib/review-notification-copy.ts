export type ReviewNotificationCopy = {
  key:
    | "notifications.newReview"
    | "notifications.newReviewWithComment"
    | "notifications.newReviewCommentOnly";
  values: {
    reviewer: string;
    worldName: string;
    rating?: number;
    comment?: string;
  };
};

export type StandaloneCommentNotificationCopy =
  | {
      key: "notifications.newReviewCommentOnly";
      values: { reviewer: string; worldName: string; comment: string };
    }
  | {
      key: "notifications.newComment";
      values: { commenter: string; worldName: string };
    };

/** Select the review-notification copy from one payload with an optional comment. */
export function getReviewNotificationCopy(
  payload: Record<string, unknown>,
  worldName: string,
): ReviewNotificationCopy {
  const reviewer =
    typeof payload.reviewerName === "string" && payload.reviewerName.trim()
      ? payload.reviewerName
      : "Someone";
  const rating =
    typeof payload.rating === "number" && Number.isFinite(payload.rating)
      ? payload.rating
      : undefined;
  const comment =
    typeof payload.commentContent === "string" && payload.commentContent.trim()
      ? payload.commentContent.trim()
      : undefined;

  if (comment && rating !== undefined) {
    return {
      key: "notifications.newReviewWithComment",
      values: { reviewer, worldName, rating, comment },
    };
  }
  if (comment) {
    return {
      key: "notifications.newReviewCommentOnly",
      values: { reviewer, worldName, comment },
    };
  }
  return {
    key: "notifications.newReview",
    values: { reviewer, worldName, rating },
  };
}

/** Preserve legacy comment rows while showing content when newer payloads include it. */
export function getStandaloneCommentNotificationCopy(
  payload: Record<string, unknown>,
  worldName: string,
): StandaloneCommentNotificationCopy {
  const commenter =
    typeof payload.commenterName === "string" && payload.commenterName.trim()
      ? payload.commenterName
      : "Someone";
  const comment =
    typeof payload.commentContent === "string" && payload.commentContent.trim()
      ? payload.commentContent.trim()
      : undefined;

  if (comment) {
    return {
      key: "notifications.newReviewCommentOnly",
      values: { reviewer: commenter, worldName, comment },
    };
  }
  return {
    key: "notifications.newComment",
    values: { commenter, worldName },
  };
}
