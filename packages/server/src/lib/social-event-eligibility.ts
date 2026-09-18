const INITIAL_REVIEW_DELAY_MS = 24 * 60 * 60 * 1_000;

export function resolveSocialSubmissionTimes(input: {
  postPublishedAt?: string;
  registrationOpensAt: Date;
  receivedAt?: Date;
}): { publishedAt: Date; initialReviewEligibleAt: Date } {
  const receivedAt = input.receivedAt ?? new Date();
  const publishedAt = input.postPublishedAt ? new Date(input.postPublishedAt) : receivedAt;
  if (!Number.isFinite(publishedAt.getTime())) {
    throw new Error("SOCIAL_POST_PUBLISHED_AT_INVALID");
  }
  if (publishedAt < input.registrationOpensAt) {
    throw new Error("SOCIAL_POST_PUBLISHED_BEFORE_EVENT");
  }
  if (publishedAt > receivedAt) {
    throw new Error("SOCIAL_POST_PUBLISHED_IN_FUTURE");
  }
  return {
    publishedAt,
    initialReviewEligibleAt: new Date(receivedAt.getTime() + INITIAL_REVIEW_DELAY_MS),
  };
}
