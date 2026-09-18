export interface ReferralCampaignView {
  id: string;
  state: 'upcoming' | 'active' | 'ended' | 'paused' | 'full';
  startsAt: string;
  endsAt: string;
  reward: number;
  maxRewards: number;
  qualificationDays: number;
  rewarded: number;
  pending: number;
  remaining: number;
  slotsRemaining: number;
  bonusExpiresAt: string;
}
export type ReferralQualificationStatus = 'pending' | 'rewarded' | 'expired' | 'limit' | 'unavailable' | 'ineligible';
export interface ReferralQualificationView {
  status: ReferralQualificationStatus;
  turns: number;
  seconds: number;
  returned: boolean;
  deadline: string;
  returnEligibleAt: string | null;
  rewardedAt: string | null;
  expiresAt: string | null;
}
/** A second UTC date AND >=24 hours avoid two claims around midnight. */
export function qualifiesReferral(input: {turns:number;seconds:number;firstPlayAt:Date|null;lastPlayAt:Date|null}) {
  const first=input.firstPlayAt,last=input.lastPlayAt;
  const returned=!!first&&!!last&&+last-+first>=86_400_000&&first.toISOString().slice(0,10)!==last.toISOString().slice(0,10);
  return {returned,qualified:returned&&(input.turns>=3||input.seconds>=600)};
}
