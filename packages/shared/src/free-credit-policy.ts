export const FREE_CHECK_IN_REWARDS = [50, 50, 62, 63, 75, 75, 125] as const;
export const LEGACY_CHECK_IN_REWARDS = [100, 100, 125, 125, 150, 150, 250] as const;
export interface FreeCreditRollout {
  enabled: boolean;
  launchAt: string | null;
  existingAt: string | null;
}
export const FREE_CREDIT_ROLLOUT_OFF: FreeCreditRollout = { enabled: false, launchAt: null, existingAt: null };
export interface FreePolicyAccount {
  createdAt: Date;
  effectivePlan: string;
  cycleStart: Date;
}
function ready(config: FreeCreditRollout, now: Date) {
  const launch = Date.parse(config.launchAt ?? '');
  const existing = Date.parse(config.existingAt ?? '');
  return config.enabled && Number.isFinite(launch) && Number.isFinite(existing) && existing >= launch && now.getTime() >= launch;
}
export function reducedFreeRewards(account: FreePolicyAccount, config: FreeCreditRollout, now = new Date()): boolean {
  return account.effectivePlan === 'free' && ready(config, now) && (
    account.createdAt.getTime() >= Date.parse(config.launchAt!) || now.getTime() >= Date.parse(config.existingAt!)
  );
}
export function reducedFreeCycle(account: FreePolicyAccount, config: FreeCreditRollout, now = new Date()): boolean {
  return account.effectivePlan === 'free' && ready(config, now) && (
    account.createdAt.getTime() >= Date.parse(config.launchAt!) || account.cycleStart.getTime() >= Date.parse(config.existingAt!)
  );
}
export function freeRewardSchedule(account: FreePolicyAccount, config: FreeCreditRollout, now = new Date()) {
  return reducedFreeRewards(account, config, now) ? FREE_CHECK_IN_REWARDS : LEGACY_CHECK_IN_REWARDS;
}
/** Reward days roll globally at 20:00 UTC; display in UTC or the viewer's local timezone. */
export function bonusRewardGroup(at: Date): { month: string; expiresAt: Date } {
  if (!Number.isFinite(at.getTime())) throw new Error('INVALID_REWARD_DATE');
  const shifted = new Date(at.getTime() + 4 * 60 * 60 * 1000);
  return {
    month: shifted.toISOString().slice(0, 7),
    expiresAt: new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 2, 1) - 4 * 60 * 60 * 1000),
  };
}
export interface WalletBonusGroup { id: string; amount: number; expiresAt: string; origin: string }
export interface WalletBreakdown {
  version: 1;
  /** Billing lineup the wallet lives under: 1 = legacy, 2 = 2026-09 (drops, quests, no refill). */
  planVersion?: number;
  /** Next scheduled drop of the cycle pile for lineup-2 wallets; null when all drops are out. */
  nextDrop?: { amount: number; at: string } | null;
  total: number;
  monthly: number;
  bonus: number;
  saved: number;
  monthlyResetsAt: string;
  groups: WalletBonusGroup[];
  policy: { reducedCycle: boolean; reducedCheckins: boolean; checkinsChangeAt: string | null; cycleChangeAt: string | null };
}
export interface WalletSpendAllocation { bucket: 'monthly' | 'bonus' | 'saved'; lotId: string | null; amount: number; expiresAt: string | null; origin: string }
/** Pure allocation; no mutation, no conversion of expired promotions into Saved. */
export function allocateWalletSpend(input: { amount: number; total: number; addon: number; monthlyEnd: string; groups: WalletBonusGroup[]; now: Date }): WalletSpendAllocation[] {
  const { amount, total, addon, groups, now } = input;
  if (![amount,total,addon].every(Number.isFinite) || amount <= 0 || addon < 0 || total < addon - 0.01) throw new Error('INVALID_WALLET_AMOUNT');
  const bonus = groups.reduce((sum,g)=>sum+g.amount,0);
  if (bonus > addon + 0.01 || groups.some(g=>g.amount<0 || !Number.isFinite(g.amount) || !Number.isFinite(Date.parse(g.expiresAt)))) throw new Error('BONUS_BALANCE_MISMATCH');
  const candidates: WalletSpendAllocation[] = [
    { bucket:'monthly' as const,lotId:null,amount:Math.max(0,total-addon),expiresAt:input.monthlyEnd,origin:'monthly' },
    ...groups.filter(g=>Date.parse(g.expiresAt)>now.getTime()).map(g=>({bucket:'bonus' as const,lotId:g.id,amount:g.amount,expiresAt:g.expiresAt,origin:g.origin})),
    { bucket:'saved' as const,lotId:null,amount:Math.max(0,addon-bonus),expiresAt:null,origin:'saved' },
  ].sort((a,b)=>(a.expiresAt?Date.parse(a.expiresAt):Infinity)-(b.expiresAt?Date.parse(b.expiresAt):Infinity) || (a.lotId??'').localeCompare(b.lotId??''));
  let remaining=Math.round(amount*1e6);const result:WalletSpendAllocation[]=[];
  for(const candidate of candidates){const used=Math.min(remaining,Math.round(candidate.amount*1e6));if(used>0)result.push({...candidate,amount:used/1e6});remaining-=used;if(remaining===0)break;}
  if(remaining>0)throw new Error('INSUFFICIENT_CREDITS');
  return result;
}
/** Stable transfer disclosure: preserves expiring funding without exposing account/lot IDs. */
export function giftFundingDisclosure(allocations: WalletSpendAllocation[], freeMonthly: boolean): { amount: number; expiresAt: string | null }[] {
  const grouped=new Map<string,number>();
  for(const a of allocations){const expires=a.bucket==='bonus'||(a.bucket==='monthly'&&freeMonthly)?a.expiresAt:null;const key=expires??'saved';grouped.set(key,(grouped.get(key)??0)+Math.round(a.amount*1e6));}
  return [...grouped].sort(([a],[b])=>a.localeCompare(b)).map(([key,amount])=>({amount:amount/1e6,expiresAt:key==='saved'?null:key}));
}
