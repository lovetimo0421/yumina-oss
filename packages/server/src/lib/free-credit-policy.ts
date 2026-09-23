import { sql } from 'drizzle-orm';
import { allocateWalletSpend, walletTolerance, bonusRewardGroup, reducedFreeCycle, reducedFreeRewards, type FreeCreditRollout, type WalletBonusGroup, type WalletBreakdown, type WalletSpendAllocation } from '@yumina/shared';
import { db } from '../db/index.js';
import { insertHashedTransaction, type LedgerDatabase } from './transaction-hash.js';
import { PLANS, type PlanId } from './plan-config.js';
import { PLANS_V2 } from './plan-config-v2.js';
import { nextDropFor } from './plan-drops.js';

export const bonusCompatibilityEnabled = () => process.env.WALLET_BONUS_COMPAT_ENABLED === 'true';
export function freeCreditRollout(): FreeCreditRollout {
  const enabled = process.env.FREE_CREDIT_POLICY_ENABLED === 'true';
  const launchAt = process.env.FREE_CREDIT_POLICY_LAUNCH_AT || null;
  const existingAt = process.env.FREE_CREDIT_POLICY_EXISTING_AT || null;
  if (enabled && (!bonusCompatibilityEnabled() || !launchAt || !existingAt || !Number.isFinite(Date.parse(launchAt)) || !Number.isFinite(Date.parse(existingAt)) || Date.parse(existingAt)<Date.parse(launchAt))) throw new Error('FREE_CREDIT_POLICY_NOT_CONFIGURED');
  return { enabled, launchAt, existingAt };
}
type Rows<T> = { rows: T[] };
const utcDate=(value:Date|string)=>value instanceof Date?value:new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value)?value:value.replace(' ','T')+'Z');
export async function policyAccount(userId: string, plan: string, cycleStart: Date, database: LedgerDatabase = db) {
  const result=await database.execute(sql`SELECT created_at FROM "user" WHERE id=${userId}`) as Rows<{created_at:Date|string}>;
  if(!result.rows[0])throw new Error('WALLET_ACCOUNT_MISSING');
  const raw=result.rows[0].created_at;
  return {createdAt: utcDate(raw),effectivePlan:plan,cycleStart};
}
export async function cyclePlanConfig(userId: string, plan: PlanId, cycleStart: Date, now=new Date(), database:LedgerDatabase=db, planVersion=1) {
  const base=PLANS[plan],rollout=freeCreditRollout();
  // Billing lineup v2 (plan-config-v2.ts): the pile is the v2 amount, there is no
  // daily refill, and grants are paid in drops (see plan-drops.ts). Version is a
  // property of the wallet, so callers pass it explicitly.
  if(planVersion===2){const v2=PLANS_V2[plan];return {...base,monthlyCredits:v2.monthlyCredits,dailyRecoveryAmount:0,monthlyRecoveryCap:0};}
  if(plan!=='free'||!rollout.enabled)return base;
  return reducedFreeCycle(await policyAccount(userId,plan,cycleStart,database),rollout,now)?{...base,monthlyCredits:1000,monthlyRecoveryCap:500,dailyRecoveryAmount:100}:base;
}
export async function useBonusRewards(userId:string,plan:string,cycleStart:Date,now=new Date(),database:LedgerDatabase=db){
  const rollout=freeCreditRollout();
  return rollout.enabled&&reducedFreeRewards(await policyAccount(userId,plan,cycleStart,database),rollout,now);
}
export async function recordCyclePolicy(database:LedgerDatabase,walletId:string,periodStart:Date,monthly:number){
  if(!bonusCompatibilityEnabled())return;
  await database.execute(sql`INSERT INTO wallet_free_cycles(wallet_id,period_start,monthly_credits,recovery_floor,recovery_cap) VALUES(${walletId},${periodStart},${monthly},${monthly===1000?100:200},${monthly===1000?500:1000}) ON CONFLICT(wallet_id) DO UPDATE SET period_start=excluded.period_start,monthly_credits=excluded.monthly_credits,recovery_floor=excluded.recovery_floor,recovery_cap=excluded.recovery_cap`);
}
/** Frozen cycle terms, shared with the recovery job; old 1,000-credit rows are not new-policy proof. */
export async function currentCycleTerms(walletId:string,periodStart:Date,plan:string,database:LedgerDatabase=db){
  const base=PLANS[plan as PlanId]??PLANS.free;
  if(plan!=='free'||!bonusCompatibilityEnabled())return {floor:base.dailyRecoveryAmount,cap:base.monthlyRecoveryCap,reduced:false};
  const result=await database.execute(sql`SELECT monthly_credits,recovery_floor,recovery_cap FROM wallet_free_cycles WHERE wallet_id=${walletId} AND period_start=${periodStart}`) as Rows<{monthly_credits:number;recovery_floor:number;recovery_cap:number}>;
  const cycle=result.rows[0];
  return cycle?{floor:Number(cycle.recovery_floor),cap:Number(cycle.recovery_cap),reduced:Number(cycle.monthly_credits)===1000}:{floor:base.dailyRecoveryAmount,cap:base.monthlyRecoveryCap,reduced:false};
}
export async function bonusGroups(database:LedgerDatabase,walletId:string):Promise<WalletBonusGroup[]>{
  if(!bonusCompatibilityEnabled())return [];
  const r=await database.execute(sql`SELECT id,remaining,expires_at,origin FROM wallet_bonus_lots WHERE wallet_id=${walletId} AND remaining>0 ORDER BY expires_at,id`) as Rows<{id:string;remaining:string;expires_at:Date|string;origin:string}>;
  return r.rows.map(g=>({id:g.id,amount:Number(g.remaining),expiresAt:new Date(g.expires_at).toISOString(),origin:g.origin}));
}
export async function expireWalletBonus(userId:string,database:LedgerDatabase=db,now=new Date()) {
  if(!bonusCompatibilityEnabled())return;
  const due=await database.execute(sql`SELECT 1 FROM wallet_bonus_lots l JOIN credit_wallets w ON w.id=l.wallet_id WHERE w.user_id=${userId} AND l.remaining>0 AND l.expires_at<=${now} LIMIT 1`) as Rows<{}>;
  if(!due.rows.length)return;
  await database.transaction(async tx=>{
    const r=await tx.execute(sql`SELECT id,balance,addon_balance FROM credit_wallets WHERE user_id=${userId} FOR UPDATE`) as Rows<{id:string;balance:number;addon_balance:number}>;
    const wallet=r.rows[0];if(!wallet)return;
    const expired=await tx.execute(sql`SELECT id,remaining FROM wallet_bonus_lots WHERE wallet_id=${wallet.id} AND remaining>0 AND expires_at<=${now}`) as Rows<{id:string;remaining:string}>;
    const amount=expired.rows.reduce((s,r)=>s+Number(r.remaining),0);if(amount===0)return;
    if(amount>Number(wallet.addon_balance)+walletTolerance(amount,Number(wallet.addon_balance))||amount>Number(wallet.balance)+walletTolerance(amount,Number(wallet.balance)))throw new Error('BONUS_BALANCE_MISMATCH');
    const updated=await tx.execute(sql`UPDATE credit_wallets SET balance=GREATEST(0,balance-${amount}),addon_balance=GREATEST(0,addon_balance-${amount}),updated_at=${now} WHERE id=${wallet.id} RETURNING balance`) as Rows<{balance:number}>;
    await tx.execute(sql`UPDATE wallet_bonus_lots SET remaining=0 WHERE wallet_id=${wallet.id} AND remaining>0 AND expires_at<=${now}`);
    await insertHashedTransaction({walletId:wallet.id,amount:-amount,type:'bonus_expiry',balanceAfter:Number(updated.rows[0]!.balance),description:'Unused Bonus expired at its disclosed date'},tx);
  });
}
export async function attachBonus(database:LedgerDatabase,walletId:string,amount:number,reference:string,origin:string,expiresAt=bonusRewardGroup(new Date()).expiresAt){
  if(!bonusCompatibilityEnabled())throw new Error('BONUS_COMPATIBILITY_REQUIRED');
  if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(expiresAt.getTime()))throw new Error('INVALID_BONUS_GRANT');
  // Caller adds the same amount to total and aggregate addon inside this transaction.
  // A duplicate reference must roll back the caller's grant, never silently mint twice.
  await database.execute(sql`INSERT INTO wallet_bonus_lots(id,wallet_id,origin,reference_id,remaining,expires_at) VALUES(${crypto.randomUUID()},${walletId},${origin},${reference},${amount},${expiresAt})`);
}
export async function prepareWalletSpend(database:LedgerDatabase,userId:string,amount:number,now=new Date(),floor=0){
  await expireWalletBonus(userId,database,now);
  const r=await database.execute(sql`SELECT id,balance,addon_balance,period_end FROM credit_wallets WHERE user_id=${userId} FOR UPDATE`) as Rows<{id:string;balance:number;addon_balance:number;period_end:Date|string}>;
  const wallet=r.rows[0];if(!wallet||Number(wallet.balance)-amount<floor)throw new Error('INSUFFICIENT_CREDITS');
  const groups=await bonusGroups(database,wallet.id);
  const allocations=allocateWalletSpend({amount,total:Number(wallet.balance),addon:Number(wallet.addon_balance),monthlyEnd:utcDate(wallet.period_end).toISOString(),groups,now});
  for(const a of allocations)if(a.bucket==='bonus')await database.execute(sql`UPDATE wallet_bonus_lots SET remaining=remaining-${a.amount} WHERE id=${a.lotId} AND remaining>=${a.amount}`);
  const addonSpent=allocations.filter(a=>a.bucket!=='monthly').reduce((s,a)=>s+a.amount,0);
  return {walletId:wallet.id,allocations,addonSpent};
}
export async function recordSpendAllocation(database:LedgerDatabase,transactionId:string,walletId:string,allocations:WalletSpendAllocation[]){
  await database.execute(sql`INSERT INTO wallet_spend_allocations(transaction_id,wallet_id,allocations) VALUES(${transactionId},${walletId},${JSON.stringify(allocations)}::jsonb)`);
}
export async function walletBreakdown(wallet:{id:string;userId:string;balance:number;addonBalance:number;plan:string;monthlyCredits:number;periodStart:Date;periodEnd:Date;planVersion?:number}):Promise<WalletBreakdown|null>{
  if(!bonusCompatibilityEnabled())return null;
  return db.transaction(async tx=>{
    await expireWalletBonus(wallet.userId,tx);
    const fresh=await tx.execute(sql`SELECT balance,addon_balance,period_start,period_end,monthly_credits FROM credit_wallets WHERE id=${wallet.id} FOR UPDATE`) as Rows<{balance:number;addon_balance:number;period_start:Date|string;period_end:Date|string;monthly_credits:number}>;
    const row=fresh.rows[0];if(!row)throw new Error('WALLET_MISSING');
    const current={...wallet,balance:Number(row.balance),addonBalance:Number(row.addon_balance),monthlyCredits:Number(row.monthly_credits),periodStart:utcDate(row.period_start),periodEnd:utcDate(row.period_end)};
    const groups=await bonusGroups(tx,wallet.id),bonus=groups.reduce((s,g)=>s+g.amount,0),rollout=freeCreditRollout();
    if(bonus>current.addonBalance+walletTolerance(bonus,current.addonBalance))throw new Error('BONUS_BALANCE_MISMATCH');
    const reduced=await useBonusRewards(wallet.userId,wallet.plan,current.periodStart,new Date(),tx);
    const reducedCycle=(await currentCycleTerms(wallet.id,current.periodStart,wallet.plan,tx)).reduced;
    const planVersion=wallet.planVersion??1;
    // The free-policy change notices ("check-ins change …", "monthly allowance
    // and recovery change …") describe the LEGACY lineup. A lineup-2 wallet has
    // no recovery to change and no dated cycle change, and it never writes a
    // wallet_free_cycles row — which made reducedCycle false and fired the
    // notice at every new free signup. Version 2 is simply out of scope.
    const legacyPolicy=rollout.enabled&&wallet.plan==='free'&&planVersion!==2;
    const nextDrop=await nextDropFor({id:wallet.id,plan:wallet.plan,planVersion,periodStart:current.periodStart},tx);
    return {version:1 as const,planVersion,nextDrop,total:current.balance,monthly:Math.max(0,current.balance-current.addonBalance),bonus,saved:Math.max(0,current.addonBalance-bonus),monthlyResetsAt:current.periodEnd.toISOString(),groups,policy:{reducedCycle,reducedCheckins:reduced,checkinsChangeAt:legacyPolicy&&!reduced?rollout.existingAt:null,cycleChangeAt:legacyPolicy&&!reducedCycle?nextPolicyCycle(current.periodEnd,rollout.existingAt!).toISOString():null}};
  });
}

function nextPolicyCycle(periodEnd:Date,cutoff:string){let time=periodEnd.getTime();while(time<Date.parse(cutoff))time+=30*86400000;return new Date(time);}
export async function refundWalletSpend(userId:string,transactionId:string,database:LedgerDatabase=db,now=new Date()) {
  if(!bonusCompatibilityEnabled())throw new Error('BONUS_COMPATIBILITY_REQUIRED');
  return database.transaction(async tx=>{
    await expireWalletBonus(userId,tx,now);
    const wallets=await tx.execute(sql`SELECT id,balance,period_end FROM credit_wallets WHERE user_id=${userId} FOR UPDATE`) as Rows<{id:string;balance:number;period_end:Date|string}>;
    const wallet=wallets.rows[0];if(!wallet)throw new Error('WALLET_MISSING');
    const prior=await tx.execute(sql`SELECT refund_transaction_id FROM wallet_usage_refunds WHERE original_transaction_id=${transactionId}`) as Rows<{refund_transaction_id:string}>;
    if(prior.rows.length)return {transactionId:prior.rows[0]!.refund_transaction_id,balance:Number(wallet.balance),replayed:true};
    const original=await tx.execute(sql`SELECT a.allocations FROM wallet_spend_allocations a JOIN credit_transactions t ON t.id=a.transaction_id WHERE a.transaction_id=${transactionId} AND a.wallet_id=${wallet.id} AND t.type='usage' AND t.amount<0`) as Rows<{allocations:WalletSpendAllocation[]}>;
    if(!original.rows[0])throw new Error('REFUND_ALLOCATION_UNAVAILABLE');
    let amount=0,addon=0,index=0;
    for(const source of original.rows[0].allocations){
      amount+=source.amount;
      if(source.bucket==='saved'){addon+=source.amount;continue;}
      const originalExpiry=source.expiresAt?Date.parse(source.expiresAt):0;
      if(source.bucket==='monthly'&&originalExpiry>now.getTime()&&originalExpiry===utcDate(wallet.period_end).getTime())continue;
      addon+=source.amount;
      const expires=new Date(originalExpiry>now.getTime()?originalExpiry:now.getTime()+86400000);
      await attachBonus(tx,wallet.id,source.amount,`refund:${transactionId}:${index++}`,originalExpiry>now.getTime()?source.origin:'failed_request_refund',expires);
    }
    const updated=await tx.execute(sql`UPDATE credit_wallets SET balance=balance+${amount},addon_balance=addon_balance+${addon},updated_at=${now} WHERE id=${wallet.id} RETURNING balance`) as Rows<{balance:number}>;
    const receipt=await insertHashedTransaction({walletId:wallet.id,amount,type:'usage_refund',referenceId:transactionId,balanceAfter:Number(updated.rows[0]!.balance),description:'Failed request refunded to original funding; expired amounts receive 24-hour grace'},tx);
    await tx.execute(sql`INSERT INTO wallet_usage_refunds(original_transaction_id,refund_transaction_id) VALUES(${transactionId},${receipt.id})`);
    return {transactionId:receipt.id,balance:Number(updated.rows[0]!.balance),replayed:false};
  });
}
/** Indexed, bounded cleanup. Reads/spends also settle expiry if the job is late. */
export async function expireDueBonusBatch(limit=100){
  if(!bonusCompatibilityEnabled())return 0;
  const rows=await db.execute(sql`SELECT DISTINCT w.user_id FROM wallet_bonus_lots l JOIN credit_wallets w ON w.id=l.wallet_id WHERE l.remaining>0 AND l.expires_at<=now() LIMIT ${Math.max(1,Math.min(100,limit))}`) as Rows<{user_id:string}>;
  for(const row of rows.rows)await expireWalletBonus(row.user_id);
  return rows.rows.length;
}
