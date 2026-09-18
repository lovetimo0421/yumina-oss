// One-off backfill for registration-based referral rewards.
//
// Safe defaults:
//   pnpm tsx src/db/backfill-referral-ladder.ts
//     Preview eligible, unclaimed milestones without writing.
//
//   pnpm tsx src/db/backfill-referral-ladder.ts --apply --notify
//     Grant the previewed rewards and send localized notifications.
//
// The milestone claim is insert-first and unique per user/threshold, so apply
// mode is idempotent and safe to retry. This script intentionally does not
// evaluate the separate all-time referral achievement metric.

import { and, gte, isNotNull } from "drizzle-orm";
import { db } from "./index.js";
import { user } from "./schema.js";
import {
  getClaimedMilestones,
  getRewardRawReferralCount,
  processReferralMilestones,
} from "../lib/referral-service.js";
import {
  MILESTONES,
  REFERRAL_REWARD_EPOCH,
  selectEarnedMilestones,
  type MilestoneDef,
} from "../lib/referral-rewards.js";

interface BackfillCandidate {
  userId: string;
  referralCount: number;
  milestones: MilestoneDef[];
}

function parseArgs(argv: string[]) {
  const supported = new Set(["--apply", "--notify"]);
  const unknown = argv.filter((arg) => !supported.has(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  }

  const apply = argv.includes("--apply");
  const notify = argv.includes("--notify");
  if (notify && !apply) {
    throw new Error("--notify requires --apply");
  }

  return { apply, notify };
}

async function findCandidates(): Promise<BackfillCandidate[]> {
  const rows = await db
    .selectDistinct({ id: user.referredBy })
    .from(user)
    .where(
      and(
        isNotNull(user.referredBy),
        isNotNull(user.referredAt),
        gte(user.referredAt, REFERRAL_REWARD_EPOCH),
      ),
    );
  const ids = rows.flatMap((row) => (row.id ? [row.id] : []));
  const candidates: BackfillCandidate[] = [];

  for (const userId of ids) {
    const referralCount = await getRewardRawReferralCount(userId);
    const claimed = new Set(
      (await getClaimedMilestones(userId)).map((milestone) => milestone.milestone),
    );
    const milestones = selectEarnedMilestones(
      MILESTONES,
      { raw: referralCount, confirmed: referralCount },
      claimed,
    );

    if (milestones.length > 0) {
      candidates.push({ userId, referralCount, milestones });
    }
  }

  return candidates;
}

function describeMilestones(milestones: MilestoneDef[]): string {
  return milestones.map((milestone) => milestone.threshold).join(",");
}

async function main() {
  const { apply, notify } = parseArgs(process.argv.slice(2));
  const candidates = await findCandidates();
  const rewardCount = candidates.reduce(
    (total, candidate) => total + candidate.milestones.length,
    0,
  );

  console.log(
    `[backfill] mode=${apply ? "apply" : "dry-run"} notify=${notify} ` +
      `epoch=${REFERRAL_REWARD_EPOCH.toISOString()}`,
  );
  console.log(
    `[backfill] ${candidates.length} user(s), ${rewardCount} unclaimed milestone reward(s)`,
  );

  for (const candidate of candidates) {
    console.log(
      `[backfill] ${candidate.userId}: referrals=${candidate.referralCount} ` +
        `milestones=${describeMilestones(candidate.milestones)}`,
    );
  }

  if (!apply) {
    console.log("[backfill] dry-run complete; no database changes were made");
    return;
  }

  let granted = 0;
  let failures = 0;
  for (const candidate of candidates) {
    try {
      const newlyGranted = await processReferralMilestones(candidate.userId, {
        silent: !notify,
      });
      granted += newlyGranted.length;
      console.log(
        `[backfill] ${candidate.userId}: granted=${describeMilestones(newlyGranted) || "none"}`,
      );
    } catch (error) {
      failures += 1;
      console.error(`[backfill] ${candidate.userId} failed:`, (error as Error).message);
    }
  }

  console.log(
    `[backfill] apply complete; granted=${granted}, failures=${failures}, ` +
      `candidates=${candidates.length}`,
  );

  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main()
  .catch((error) => {
    console.error("[backfill] fatal:", (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => {
    // Drizzle's Postgres client keeps sockets open after the one-off script.
    setTimeout(() => process.exit(process.exitCode ?? 0), 0);
  });
