import { deductCreditsUpToBalance } from "./credit-service.js";
import { splitShareRef, splitShares, type ResolvedRoomTurn } from "./story-rooms.js";

type Deduction = Awaited<ReturnType<typeof deductCreditsUpToBalance>>;

/**
 * Charges a story-room reply. A host-pays room charges the host as any send
 * does. A split room charges each player who acted in the round (and agreed to
 * split) an equal share first, each against their own balance; the host pays
 * the rest: their own share, the shares of players who never agreed, and
 * whatever a player's balance could not cover. So every reply is paid for in
 * full, and nobody pays for a round they took no part in.
 *
 * Returns the host's deduction, which is what the send reports as its cost.
 */
export async function chargeRoomReply(input: {
  turn: Pick<ResolvedRoomTurn, "costMode" | "hostUserId" | "actorIds" | "splitAgreed"> | null;
  hostUserId: string;
  cost: number;
  usageLogId: string;
  description: string;
  deduct?: typeof deductCreditsUpToBalance;
}): Promise<Deduction> {
  const deduct = input.deduct ?? deductCreditsUpToBalance;
  const turn = input.turn;
  if (!turn || turn.costMode !== "split") return deduct(input.hostUserId, input.cost, input.usageLogId, input.description);
  const shares = splitShares({ cost: input.cost, hostUserId: input.hostUserId, actorIds: turn.actorIds, agreed: new Set(turn.splitAgreed) });
  let collected = 0;
  for (const share of shares) {
    try {
      const paid = await deduct(share.userId, share.amount, splitShareRef(input.usageLogId, share.userId), `Shared room round — ${input.description}`);
      collected += paid?.creditsDeducted ?? 0;
    } catch (err) {
      console.error("[StoryRoomBilling] share failed:", err instanceof Error ? err.message : err);
    }
  }
  const rest = Math.max(0, Math.round((input.cost - collected) * 1000) / 1000);
  return deduct(input.hostUserId, rest, input.usageLogId, input.description);
}
