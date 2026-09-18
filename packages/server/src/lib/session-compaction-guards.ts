import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { playSessions } from "../db/schema.js";

export type StoryPreflightSnapshot = Pick<typeof playSessions.$inferSelect,
  "summaryStatus" | "summarySourceHash" | "summaryClaimedAt"
  | "summaryBudgetResumePending" | "summaryBudgetWindowStartedAt"
>;

/** A preflight rejection owns no job. Compare the state it read inside the
 * UPDATE so it cannot cancel a claim, undo Resume, or re-pause a recovered
 * session while a provider/budget check was in flight. */
export function storyPreflightFailureGuard(
  snapshot: StoryPreflightSnapshot,
  staleClaimBefore: Date,
) {
  return and(
    eq(playSessions.summaryStatus, snapshot.summaryStatus),
    or(
      ne(playSessions.summaryStatus, "updating"),
      isNull(playSessions.summaryClaimedAt),
      lt(playSessions.summaryClaimedAt, staleClaimBefore),
    ),
    snapshot.summarySourceHash === null
      ? isNull(playSessions.summarySourceHash)
      : eq(playSessions.summarySourceHash, snapshot.summarySourceHash),
    snapshot.summaryClaimedAt === null
      ? isNull(playSessions.summaryClaimedAt)
      : eq(playSessions.summaryClaimedAt, snapshot.summaryClaimedAt),
    eq(playSessions.summaryBudgetResumePending, snapshot.summaryBudgetResumePending),
    snapshot.summaryBudgetWindowStartedAt === null
      ? isNull(playSessions.summaryBudgetWindowStartedAt)
      : eq(playSessions.summaryBudgetWindowStartedAt, snapshot.summaryBudgetWindowStartedAt),
  );
}
