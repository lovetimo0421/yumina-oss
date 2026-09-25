import { sql } from 'drizzle-orm';
import { bonusRewardGroup, qualifiesReferral, type ReferralCampaignView, type ReferralQualificationView } from '@yumina/shared';
import { db } from '../db/index.js';
import { attachBonus, bonusCompatibilityEnabled } from './free-credit-policy.js';
import { insertHashedTransaction, type LedgerDatabase } from './transaction-hash.js';
import { withDatabaseQueryTimeout } from '../db/query-deadline.js';
import { scheduleQuestCollect } from './quest-auto-collect.js';

type Rows<T>={rows:T[]};
const date = (value: Date | string | null): Date | null => value == null ? null : new Date(value);
const campaignDates = (c: ReferralCampaign | undefined) => c ? {...c,starts_at:date(c.starts_at),ends_at:date(c.ends_at)} : undefined;
export type ReferralCampaign = {id:string;starts_at:Date|null;ends_at:Date|null;reward:number;max_rewards:number;qualification_days:number;reward_slots:number;paused:boolean}
export async function referralCampaign(database:LedgerDatabase=db):Promise<ReferralCampaign|null>{
  const r=await database.execute(sql`SELECT * FROM referral_reward_campaigns WHERE id='qualified-v1'`) as unknown as Rows<ReferralCampaign>;
  return r.rows[0]?.starts_at ? campaignDates(r.rows[0])! : null;
}
export async function legacyReferralCutoff(database:LedgerDatabase=db){return (await referralCampaign(database))?.starts_at??null;}

/** Called inside the same transaction as the one-time referral-code claim. */
export async function enrollQualifiedReferral(database:LedgerDatabase,inviteeId:string,referrerId:string,now=new Date()){
  const r=await database.execute(sql`SELECT * FROM referral_reward_campaigns WHERE id='qualified-v1' FOR UPDATE`) as unknown as Rows<ReferralCampaign>;
  const c=campaignDates(r.rows[0]);
  if(!c?.starts_at||now<c.starts_at)return null;
  // Reward eligibility starts with registration in this campaign. Existing
  // accounts can still redeem their own welcome offer, but cannot farm inviter rewards.
  const account=await database.execute(sql`SELECT created_at FROM "user" WHERE id=${inviteeId}`) as Rows<{created_at:Date}>;
  const counts=await database.execute(sql`SELECT count(*) FILTER(WHERE status IN ('pending','rewarded')) total,
    count(*) FILTER(WHERE referrer_id=${referrerId} AND status IN ('pending','rewarded')) mine
    FROM referral_qualifications WHERE campaign_id=${c.id}`) as Rows<{total:string;mine:string}>;
  let status:ReferralQualificationView['status']='pending';
  if(!account.rows[0]||new Date(account.rows[0].created_at)<c.starts_at)status='ineligible';
  else if(c.paused||!c.ends_at||now>=c.ends_at||Number(counts.rows[0]!.total)>=c.reward_slots)status='unavailable';
  else if(Number(counts.rows[0]!.mine)>=c.max_rewards)status='limit';
  if(status==='pending'&&!bonusCompatibilityEnabled())throw Error('REFERRAL_BONUS_NOT_CONFIGURED');
  const deadline=new Date(+now+c.qualification_days*86_400_000);
  await database.execute(sql`INSERT INTO referral_qualifications(invitee_id,referrer_id,campaign_id,joined_at,deadline,status)
    VALUES(${inviteeId},${referrerId},${c.id},${now},${deadline},${status}) ON CONFLICT(invitee_id) DO NOTHING`);
  return {status,deadline:deadline.toISOString(),reward:c.reward};
}

/** Source observations remain in Postgres. Only enrolled accounts are checked;
 * signed game counters and foreground intervals are unioned, never wall-clock visits. */
export async function referralEvidence(userId:string,start:Date,end:Date,database:LedgerDatabase=db){
  const r=await database.execute(sql`
    WITH subjects AS (SELECT ${userId}::text id UNION SELECT guest_id FROM game_guest_links WHERE user_id=${userId}),
    turns AS (
      (SELECT id,created_at AT TIME ZONE 'UTC' at FROM usage_logs WHERE user_id=${userId} AND created_at>=${start} AND created_at<${end}
        AND endpoint IN ('send','regenerate','continue','pvz-dave') AND completion_tokens>0 ORDER BY created_at LIMIT 3)
      UNION
      (SELECT id,created_at AT TIME ZONE 'UTC' at FROM usage_logs WHERE user_id=${userId} AND created_at>=${start} AND created_at<${end}
        AND endpoint IN ('send','regenerate','continue','pvz-dave') AND completion_tokens>0 ORDER BY created_at DESC LIMIT 1)
    ), raw_games AS (
      SELECT e.event_at at,e.payload p FROM subjects s JOIN game_lifecycle_events e ON e.payload->>'subject'=s.id
        WHERE e.event_at>=${start} AND e.event_at<${end} AND e.received_at<${end}
          AND e.payload->>'version'='2' AND e.payload->>'environment'='production'
    ), baselines AS (
      SELECT b.event_at at,b.payload p FROM (SELECT DISTINCT p->>'subject' subject,p->>'session' session FROM raw_games) s
      CROSS JOIN LATERAL (SELECT e.event_at,e.payload FROM game_lifecycle_events e WHERE e.payload->>'subject'=s.subject
        AND e.payload->>'session'=s.session AND e.event_at<${start} AND e.payload->>'version'='2' AND e.payload->>'environment'='production'
        ORDER BY e.event_at DESC LIMIT 1) b
    ), counters AS (
      SELECT at,p,
        lag(at) OVER w prev_at,
        coalesce(max((p->>'engagedMs')::bigint) OVER prev,0) prev_ms,
        coalesce(max((p->>'actions')::bigint) OVER prev,0) prev_actions
      FROM (SELECT * FROM raw_games UNION ALL SELECT * FROM baselines) g
      WINDOW w AS (PARTITION BY p->>'subject',p->>'session' ORDER BY at,(p->>'sequence')::bigint),
        prev AS (PARTITION BY p->>'subject',p->>'session' ORDER BY at,(p->>'sequence')::bigint ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
    ), game_deltas AS (
      SELECT at,CASE WHEN prev_at IS NULL THEN 0 ELSE least(greatest(0,(p->>'engagedMs')::bigint-prev_ms),
        greatest(0,extract(epoch FROM at-greatest(coalesce(prev_at,${start}),${start}))*1000)) END::double precision ms,
        prev_at IS NOT NULL AND (p->>'actions')::bigint>prev_actions has_action
      FROM counters WHERE at>=${start}
    ), foreground AS (
      SELECT greatest(occurred_at-interval '60 seconds',${start}) a,occurred_at b
      FROM analytics_activity WHERE user_id=${userId} AND occurred_at>=${start} AND occurred_at<${end}
        AND surface='play' AND action='foreground-engaged-60s'
    ), intervals AS (
      SELECT a,b FROM foreground WHERE b>a UNION ALL
      SELECT at-ms*interval '1 millisecond',at FROM game_deltas WHERE ms>0
    ), covered AS (SELECT range_agg(tstzrange(a,b,'[)')) spans FROM intervals),
    duration AS (SELECT coalesce(sum(extract(epoch FROM upper(span)-lower(span))),0) seconds FROM covered,LATERAL unnest(spans) span),
    actions AS (SELECT at FROM turns UNION ALL SELECT b FROM foreground UNION ALL SELECT at FROM game_deltas WHERE ms>0 OR has_action)
    SELECT (SELECT least(count(*),3)::int FROM turns) turns,(SELECT floor(seconds)::int FROM duration) seconds,
      min(at) first_play_at,max(at) last_play_at FROM actions
  `) as Rows<{turns:number;seconds:number;first_play_at:Date|null;last_play_at:Date|null}>;
  const row=r.rows[0]!;
  return {turns:Number(row.turns),seconds:Number(row.seconds),firstPlayAt:date(row.first_play_at),lastPlayAt:date(row.last_play_at)};
}

export async function settleQualifiedReferral(inviteeId:string,database:LedgerDatabase=db,now=new Date()){
  const found=await database.execute(sql`SELECT * FROM referral_qualifications WHERE invitee_id=${inviteeId} AND status='pending'`) as Rows<{
    invitee_id:string;referrer_id:string;joined_at:Date;deadline:Date;activity_version:number
  }>;
  const raw=found.rows[0];if(!raw)return false;
  const before={...raw,joined_at:new Date(raw.joined_at),deadline:new Date(raw.deadline)};
  const evidence=await referralEvidence(inviteeId,before.joined_at,new Date(Math.min(+now,+before.deadline)),database);
  const decision=qualifiesReferral(evidence);
  const rewarded=await database.transaction(async tx=>{
    const campaign=await tx.execute(sql`SELECT * FROM referral_reward_campaigns WHERE id='qualified-v1' FOR UPDATE`) as unknown as Rows<ReferralCampaign>;
    const c=campaignDates(campaign.rows[0]);if(!c)return false;
    const locked=await tx.execute(sql`SELECT status,activity_version FROM referral_qualifications WHERE invitee_id=${inviteeId} FOR UPDATE`) as Rows<{status:string;activity_version:number}>;
    const row=locked.rows[0];if(row?.status!=='pending')return false;
    const users=await tx.execute(sql`SELECT id,is_banned FROM "user" WHERE id IN (${inviteeId},${before.referrer_id})`) as Rows<{id:string;is_banned:boolean}>;
    const invalid=users.rows.length!==2||users.rows.some(u=>u.is_banned);
    const status=invalid?'ineligible':decision.qualified?'rewarded':now>=before.deadline?'expired':'pending';
    let transactionId:string|null=null,expiresAt:Date|null=null;
    // A campaign reward of 0 means the ladder IS the reward (owner 2026-09-16): no wallet write, no "+0" ledger row.
    if(status==='rewarded'&&c.reward>0){
      if(!bonusCompatibilityEnabled())throw Error('REFERRAL_BONUS_NOT_CONFIGURED');
      // Lock the wallet before touching the ledger; this is the same order as
      // all other wallet grants and makes the receipt/lot/payout atomic.
      const wallets=await tx.execute(sql`UPDATE credit_wallets SET balance=balance+${c.reward},addon_balance=addon_balance+${c.reward},updated_at=${now}
        WHERE user_id=${before.referrer_id} RETURNING id,balance`) as Rows<{id:string;balance:number}>;
      const wallet=wallets.rows[0];if(!wallet)throw Error('REFERRER_WALLET_MISSING');
      expiresAt=bonusRewardGroup(now).expiresAt;
      const reference='qualified-referral:'+inviteeId;
      await attachBonus(tx,wallet.id,c.reward,reference,'referral_qualified',expiresAt);
      const receipt=await insertHashedTransaction({walletId:wallet.id,amount:c.reward,type:'referral_reward',referenceId:reference,
        balanceAfter:Number(wallet.balance),description:'Qualified referral: returning player'},tx);
      transactionId=receipt.id;
    }
    // Lineup v2: the invitee's second 500 of the welcome gift lands now, in the
    // same transaction as the status flip, so it is paid exactly once — the
    // pending→rewarded transition is the idempotency key (referral-service.ts
    // referralWelcomePolicy pays the first half at redemption).
    if(status==='rewarded'){
      const inviteeWallet=await tx.execute(sql`SELECT id,plan_version FROM credit_wallets WHERE user_id=${inviteeId} FOR UPDATE`) as Rows<{id:string;plan_version:number|null}>;
      const w=inviteeWallet.rows[0];
      // Only friends who claimed under the old 500 + 500 offer are owed this half;
      // since 2026-09-24 a claim pays 300 once and nothing more (referral-service.ts).
      const oldOffer=w?await tx.execute(sql`SELECT 1 FROM credit_transactions WHERE wallet_id=${w.id} AND type='referral_reward'
        AND description LIKE 'Welcome bonus: referred by%' AND amount>=500 LIMIT 1`) as Rows<unknown>:{rows:[]};
      if(w&&(w.plan_version??1)===2&&oldOffer.rows.length>0){
        if(!bonusCompatibilityEnabled())throw Error('REFERRAL_BONUS_NOT_CONFIGURED');
        const half=500;
        const updated=await tx.execute(sql`UPDATE credit_wallets SET balance=balance+${half},addon_balance=addon_balance+${half},updated_at=${now}
          WHERE id=${w.id} RETURNING id,balance`) as Rows<{id:string;balance:number}>;
        const ref='referral-welcome-active:'+inviteeId;
        const exp=bonusRewardGroup(now).expiresAt;
        await attachBonus(tx,w.id,half,ref,'referral_welcome',exp);
        await insertHashedTransaction({walletId:w.id,amount:half,type:'referral_reward',referenceId:ref,
          balanceAfter:Number(updated.rows[0]!.balance),description:'Welcome bonus, part 2: you qualified as an active friend'},tx);
      }
    }
    await tx.execute(sql`UPDATE referral_qualifications SET status=${status},turns=${evidence.turns},seconds=${Math.min(600,evidence.seconds)},returned=${decision.returned},
      first_play_at=${evidence.firstPlayAt},return_eligible_at=${evidence.firstPlayAt?new Date(+evidence.firstPlayAt+86_400_000):null},
      checked_at=${now},next_check_at=${row.activity_version!==before.activity_version?now:new Date(+now+600_000)},
      transaction_id=${transactionId},reward_expires_at=${expiresAt},rewarded_at=${status==='rewarded'?now:null} WHERE invitee_id=${inviteeId}`);
    return status==='rewarded';
  });
  if(rewarded)scheduleQuestCollect(before.referrer_id); // "3 active friends this week" may just have finished
  if(rewarded){
    // The reward ladder and the Wayfinder title both count ACTIVE friends, so they
    // advance here, when the friend qualifies — not at registration. Dynamic
    // imports: referral-service imports this module for legacyReferralCutoff.
    const [{processReferralMilestones},{onReferralRegistered}]=await Promise.all([import('./referral-service.js'),import('./achievements/engine.js')]);
    await processReferralMilestones(before.referrer_id).catch(e=>console.error('[Referral] ladder after qualification',e instanceof Error?e.message:e));
    await onReferralRegistered(before.referrer_id).catch(e=>console.error('[Referral] title after qualification',e instanceof Error?e.message:e));
  }
  return rewarded;
}

export async function sweepQualifiedReferrals(limit=50){
  if(!bonusCompatibilityEnabled())return;
  const rows=await db.execute(sql`SELECT invitee_id FROM referral_qualifications WHERE status='pending' AND next_check_at<=now()
    ORDER BY next_check_at LIMIT ${Math.min(100,Math.max(1,limit))}`) as Rows<{invitee_id:string}>;
  for(const row of rows.rows){
    try{await withDatabaseQueryTimeout(5000,()=>settleQualifiedReferral(row.invitee_id));}catch(error){
      console.error('[Referral] qualification retry',error instanceof Error?error.message:'failed');
      await db.execute(sql`UPDATE referral_qualifications SET next_check_at=now()+interval '1 minute' WHERE invitee_id=${row.invitee_id} AND status='pending'`);
    }
  }
}

export async function qualifiedReferralView(referrerId:string,database:LedgerDatabase=db,now=new Date()): Promise<{campaign:ReferralCampaignView|null;qualifications:Record<string,ReferralQualificationView>}>{
  const c=await referralCampaign(database);if(!c)return {campaign:null,qualifications:{}};
  const r=await database.execute(sql`SELECT invitee_id,status,turns,seconds,returned,deadline,return_eligible_at,rewarded_at,reward_expires_at
    FROM referral_qualifications WHERE referrer_id=${referrerId} AND campaign_id=${c.id}`) as Rows<{
      invitee_id:string;status:ReferralQualificationView['status'];turns:number;seconds:number;returned:boolean;deadline:Date;
      return_eligible_at:Date|null;rewarded_at:Date|null;reward_expires_at:Date|null
    }>;
  const used=await database.execute(sql`SELECT count(*) n FROM referral_qualifications WHERE campaign_id=${c.id} AND status IN ('pending','rewarded')`) as Rows<{n:string}>;
  const rewarded=r.rows.filter(r=>r.status==='rewarded').length,pending=r.rows.filter(r=>r.status==='pending').length;
  const slotsRemaining=Math.max(0,c.reward_slots-Number(used.rows[0]!.n));
  const campaign:ReferralCampaignView={id:c.id,state:now<c.starts_at!?'upcoming':now>=c.ends_at!?'ended':c.paused?'paused':!slotsRemaining?'full':'active',
    startsAt:c.starts_at!.toISOString(),endsAt:c.ends_at!.toISOString(),reward:c.reward,maxRewards:c.max_rewards,qualificationDays:c.qualification_days,
    rewarded,pending,remaining:Math.max(0,c.max_rewards-rewarded-pending),slotsRemaining,bonusExpiresAt:bonusRewardGroup(now).expiresAt.toISOString()};
  return {campaign,qualifications:Object.fromEntries(r.rows.map(row=>[row.invitee_id,{status:row.status,turns:row.turns,seconds:row.seconds,returned:row.returned,
    deadline:new Date(row.deadline).toISOString(),returnEligibleAt:date(row.return_eligible_at)?.toISOString()??null,rewardedAt:date(row.rewarded_at)?.toISOString()??null,expiresAt:date(row.reward_expires_at)?.toISOString()??null} satisfies ReferralQualificationView]))};
}
