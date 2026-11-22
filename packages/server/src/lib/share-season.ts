import { and, eq, sql } from "drizzle-orm";
import { db, flagWrite } from "../db/index.js";
import { creditWallets, shareSeasonAwards } from "../db/schema.js";
import { ensureWallet } from "./credit-service.js";
import { attachBonus, bonusCompatibilityEnabled } from "./free-credit-policy.js";
import { PLANS, type PlanId } from "./plan-config.js";
import { posthog } from "./posthog.js";
import { grantStackingPlanReward } from "./referral-service.js";
import { insertHashedTransaction } from "./transaction-hash.js";

/**
 * 分享季 (2026-11-10 to 12-10): share what you made so others can use it.
 *
 * Three tracks: 资源包 (public packs), 音乐音效 (sounds shared on the 广场) and 声音 (public voices). Whatever of
 * these someone shares during the month, and that passed the usual review, is an entry: there is nothing to
 * submit. We look at each entry ourselves and give it a grade, about a week after it is shared, the way the
 * creator event is judged. Numbers a person could move (uses, likes, posts) decide nothing; the judges see the
 * use count beside each entry as one thing to weigh.
 *
 * A grade is one press and carries everything it pays: its mushies and, for the two upper grades, a month of
 * membership, so neither half can be left out (the creator event's memberships were, and had to be made up).
 * An entry is graded once. One judged "not this time" can still be given a grade later; a grade is never taken
 * back or changed, because it has been paid.
 */
export const SHARE_SEASON_ID = "share-season-2026";

export function shareSeasonWindow(): { startsAt: Date; endsAt: Date } {
  const parse = (value: string | undefined, fallback: string) => {
    const d = new Date(value || fallback);
    return Number.isFinite(d.getTime()) ? d : new Date(fallback);
  };
  return {
    // Reward-day boundaries (04:00 Asia/Shanghai): Nov 10 to Dec 10, one month.
    startsAt: parse(process.env.SHARE_SEASON_STARTS_AT, "2026-11-09T20:00:00Z"),
    endsAt: parse(process.env.SHARE_SEASON_ENDS_AT, "2026-12-09T20:00:00Z"),
  };
}

/** The event is built but not opened yet (Jason, 2026-11-10: "活动先不着急"). SHARE_SEASON_ENABLED=1 opens it. */
export const shareSeasonEnabled = () => process.env.SHARE_SEASON_ENABLED === "1";

export function shareSeasonActive(now: Date = new Date()): boolean {
  if (!shareSeasonEnabled()) return false;
  const { startsAt, endsAt } = shareSeasonWindow();
  return now >= startsAt && now < endsAt;
}

/** Judging goes on for two weeks after the last day: an entry shared on the last day still gets its week. */
const JUDGING_MS = 14 * 24 * 3600 * 1000;
export function shareSeasonJudging(now: Date = new Date()): boolean {
  if (!shareSeasonEnabled()) return false;
  const { startsAt, endsAt } = shareSeasonWindow();
  return now >= startsAt && now.getTime() < endsAt.getTime() + JUDGING_MS;
}

export const SHARE_TRACKS = ["bundle", "audio", "voice"] as const;
export type ShareTrack = (typeof SHARE_TRACKS)[number];

/** The grades a judge can give, lowest first. "none" is "not this time" and pays nothing. */
export const SHARE_GRADES = [
  { id: "pick", reward: 1000, plan: null },
  { id: "fine", reward: 3000, plan: { id: "go", days: 30 } },
  { id: "best", reward: 8000, plan: { id: "plus", days: 30 } },
] as const satisfies ReadonlyArray<{ id: string; reward: number; plan: { id: PlanId; days: number } | null }>;
export type ShareGrade = (typeof SHARE_GRADES)[number];
export type ShareGradeId = ShareGrade["id"] | "none";

export const gradeOf = (id: string): ShareGrade | null => SHARE_GRADES.find((g) => g.id === id) ?? null;
export const gradePlan = (grade: ShareGrade): { name: string; days: number } | null =>
  grade.plan ? { name: PLANS[grade.plan.id].displayName, days: grade.plan.days } : null;
export const gradesJson = () => SHARE_GRADES.map((g) => ({ id: g.id, reward: g.reward, plan: gradePlan(g) }));

export interface ShareEntry {
  track: ShareTrack;
  id: string;
  title: string;
  userId: string;
  authorName: string | null;
  /** When it became an entry: when it was shared, or passed review. */
  at: string;
  /** How many others used it, for the judges to weigh. */
  uses: number;
  /** null: not judged yet. */
  grade: ShareGradeId | null;
  mushies: number;
}

type Row = { track: ShareTrack; id: string; title: string; user_id: string; author_name: string | null; at: Date | string; uses: number | string; grade: string | null; mushies: number | null };

/**
 * The entries: everything shared in the window that passed review, with its grade if it has one.
 * `userId`: one person's own. `pending`: only those not judged yet (the judges' list, oldest first).
 */
export async function shareEntries(opts: { userId?: string; pending?: boolean; limit?: number } = {}): Promise<ShareEntry[]> {
  const { startsAt, endsAt } = shareSeasonWindow();
  const from = startsAt.toISOString(), to = endsAt.toISOString();
  const mine = opts.userId ? sql`AND e.user_id = ${opts.userId}` : sql``;
  // The judges do not grade the official account's own shares.
  const notOfficial = opts.userId ? sql`` : sql`AND u.role IS DISTINCT FROM 'admin'`;
  const pending = opts.pending ? sql`AND a.item_id IS NULL` : sql``;
  const result = await db.execute(sql`
    SELECT e.track, e.id, e.title, e.user_id, u.name AS author_name, e.at, e.uses, a.grade, a.mushies
    FROM (
      SELECT 'bundle' AS track, b.id, b.name AS title, b.user_id, COALESCE(b.reviewed_at, b.created_at) AS at,
        (SELECT COUNT(*) FROM bundle_takes t WHERE t.bundle_id = b.id)::int AS uses
      FROM bundles b WHERE b.is_public = true AND b.review_status = 'approved' AND b.is_official = false AND b.user_id IS NOT NULL
      UNION ALL
      SELECT 'audio', p.id, p.title, p.user_id, COALESCE(p.approved_at, p.created_at),
        (SELECT COUNT(*) FROM image_post_takes t WHERE t.post_id = p.id)::int
      FROM image_posts p WHERE p.media_kind = 'audio' AND p.status = 'approved'
      UNION ALL
      SELECT 'voice', v.id, v.name, v.user_id, COALESCE(v.reviewed_at, v.created_at), v.use_count
      FROM workbench_elements v WHERE v.kind = 'voice' AND v.visibility = 'public' AND v.status = 'approved'
    ) e
    JOIN "user" u ON u.id = e.user_id
    LEFT JOIN share_season_awards a ON a.track = e.track AND a.item_id = e.id
    WHERE e.at >= ${from}::timestamptz AND e.at < ${to}::timestamptz AND u.is_banned = false ${mine} ${notOfficial} ${pending}
    ORDER BY ${opts.pending ? sql`e.at ASC` : sql`e.at DESC`}
    LIMIT ${Math.min(opts.limit ?? 200, 500)}`) as unknown as { rows?: Row[] } | Row[];
  const rows = Array.isArray(result) ? result : result.rows ?? [];
  return rows.map((r) => ({
    track: r.track, id: r.id, title: r.title ?? "", userId: r.user_id, authorName: r.author_name, at: new Date(r.at).toISOString(), uses: Number(r.uses ?? 0),
    grade: (r.grade as ShareGradeId | null) ?? null, mushies: Number(r.mushies ?? 0),
  }));
}

export interface ShareSeasonState {
  active: boolean;
  startsAt: string;
  endsAt: string;
  grades: ReturnType<typeof gradesJson>;
  /** My own entries, newest first. */
  entries: ShareEntry[];
  /** Every mushie this event has paid this account. */
  total: number;
}

export async function shareSeasonState(userId: string): Promise<ShareSeasonState> {
  const { startsAt, endsAt } = shareSeasonWindow();
  const entries = await shareEntries({ userId });
  return {
    active: shareSeasonActive(), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), grades: gradesJson(), entries,
    total: entries.reduce((n, e) => n + e.mushies, 0),
  };
}

export type JudgeOutcome =
  | { kind: "graded"; grade: ShareGradeId; mushies: number }
  | { kind: "already"; grade: ShareGradeId }
  | { kind: "not_found" }
  | { kind: "closed" };

/**
 * Give one entry its grade. The award row is the one record: it is written and the mushies paid in the same
 * transaction, so an entry can never be paid twice; the membership follows, idempotent on its own key.
 */
export async function judgeEntry(judgeId: string, track: ShareTrack, itemId: string, gradeId: ShareGradeId): Promise<JudgeOutcome> {
  if (!shareSeasonJudging()) return { kind: "closed" };
  const entry = (await shareEntries({ limit: 500 })).find((e) => e.track === track && e.id === itemId);
  if (!entry) return { kind: "not_found" };
  const grade = gradeId === "none" ? null : gradeOf(gradeId);
  if (gradeId !== "none" && !grade) return { kind: "not_found" };
  const amount = grade?.reward ?? 0;
  const wallet = amount > 0 ? await ensureWallet(entry.userId) : null;

  const outcome = await db.transaction(async (tx): Promise<JudgeOutcome> => {
    const [had] = await tx.select().from(shareSeasonAwards).where(and(eq(shareSeasonAwards.track, track), eq(shareSeasonAwards.itemId, itemId))).for("update");
    // A grade that paid is final. "Not this time" may be given a grade later.
    if (had && had.grade !== "none") return { kind: "already", grade: had.grade as ShareGradeId };
    if (had && gradeId === "none") return { kind: "already", grade: "none" };
    const values = { track, itemId, userId: entry.userId, grade: gradeId, mushies: amount, decidedBy: judgeId, decidedAt: new Date() };
    if (had) await tx.update(shareSeasonAwards).set(values).where(and(eq(shareSeasonAwards.track, track), eq(shareSeasonAwards.itemId, itemId)));
    else {
      // Two judges pressing at once: the first row wins, the second press learns what it was given.
      const [made] = await tx.insert(shareSeasonAwards).values(values).onConflictDoNothing().returning();
      if (!made) {
        const [now] = await tx.select({ grade: shareSeasonAwards.grade }).from(shareSeasonAwards).where(and(eq(shareSeasonAwards.track, track), eq(shareSeasonAwards.itemId, itemId)));
        return { kind: "already", grade: (now?.grade ?? "none") as ShareGradeId };
      }
    }
    if (amount > 0 && wallet) {
      await tx.select().from(creditWallets).where(eq(creditWallets.userId, entry.userId)).for("update");
      const [updated] = await tx.update(creditWallets)
        .set({ balance: sql`${creditWallets.balance} + ${amount}`, addonBalance: sql`${creditWallets.addonBalance} + ${amount}`, updatedAt: new Date() })
        .where(eq(creditWallets.userId, entry.userId)).returning();
      if (!updated) throw new Error("SHARE_SEASON_WALLET_UPDATE_FAILED");
      const reference = `event:${SHARE_SEASON_ID}:${track}:${itemId}`;
      if (bonusCompatibilityEnabled()) await attachBonus(tx, wallet.id, amount, reference, "check_in");
      await insertHashedTransaction({ walletId: wallet.id, amount, type: "check_in", referenceId: reference, balanceAfter: updated.balance,
        description: `Share season · ${track} · ${gradeId}` }, tx);
    }
    return { kind: "graded", grade: gradeId, mushies: amount };
  });

  if (outcome.kind === "graded") {
    if (grade?.plan) {
      // After the mushies, on its own key: a retry of the same press finishes it if it did not land.
      await grantStackingPlanReward(entry.userId, grade.plan.id, grade.plan.days, {
        sourceId: `${SHARE_SEASON_ID}:${track}:${itemId}`, idempotencyKey: `${SHARE_SEASON_ID}:${track}:${itemId}`,
      }).catch((error) => console.error(`[ShareSeason] membership for ${track}:${itemId} not granted to ${entry.userId}:`, error instanceof Error ? error.message : error));
    }
    await flagWrite(entry.userId).catch(() => {});
    try { posthog.capture({ distinctId: entry.userId, event: "share_season_graded", properties: { track, grade: gradeId, mushies: amount } }); }
    catch { /* diagnostics must never change the outcome */ }
  }
  return outcome;
}
