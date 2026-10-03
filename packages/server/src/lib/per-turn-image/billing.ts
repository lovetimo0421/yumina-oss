// What a per-turn picture costs the player: a flat price per delivered
// picture (PER_TURN_IMAGE_PRICE_MUSHIES), the first few per account free
// (PER_TURN_IMAGE_FREE_COUNT), nothing on an unlimited plan.
//
// Paid up front and refunded when the picture doesn't land. Deciding the price
// and taking it happen under the wallet row lock, so two draws at once can't
// both use the last free picture, and a chat turn can't spend the money
// between the price check and the charge. BYOK players pay too: their key
// covers the chat model, the picture runs on our GPUs.
//
// The free allowance is counted from the ledger (every draw writes a
// `turn-image:` usage row, free ones at 0; a refund writes a refund row under
// the same reference), never from anything the player can edit.

import { and, count, eq, like } from "drizzle-orm";
import { db } from "../../db/index.js";
import { creditTransactions, creditWallets } from "../../db/schema.js";
import { checkBalance, deductCredits, refundCredits } from "../credit-service.js";
import { env } from "../env.js";
import { PLANS } from "../plan-config.js";
import { insertHashedTransaction, type LedgerDatabase } from "../transaction-hash.js";

const REF_PREFIX = "turn-image:";

export interface TurnImageQuote {
  /** Mushies this picture will cost (0 while free or on an unlimited plan). */
  price: number;
  /** The list price, for showing next to the switch. */
  listPrice: number;
  freeLeft: number;
  unlimited: boolean;
  balance: number;
  /** False when the player can't pay for the next picture. */
  affordable: boolean;
}

/** Pictures that count against the free allowance: draws minus refunded draws. */
async function usedTurnImages(walletId: string, database: LedgerDatabase): Promise<number> {
  const rows = await database.select({ type: creditTransactions.type, n: count() }).from(creditTransactions)
    .where(and(eq(creditTransactions.walletId, walletId), like(creditTransactions.referenceId, `${REF_PREFIX}%`)))
    .groupBy(creditTransactions.type);
  const of = (type: string) => Number(rows.find((r) => r.type === type)?.n ?? 0);
  return Math.max(0, of("usage") - of("refund"));
}

function priceFor(used: number, unlimited: boolean) {
  const freeLeft = Math.max(0, env.PER_TURN_IMAGE_FREE_COUNT - used);
  const listPrice = env.PER_TURN_IMAGE_PRICE_MUSHIES;
  return { freeLeft, listPrice, price: unlimited || freeLeft > 0 ? 0 : listPrice };
}

/** For showing next to the switch. The real price is set by reserveTurnImage. */
export async function turnImageQuote(userId: string): Promise<TurnImageQuote> {
  const { wallet, balance } = await checkBalance(userId);
  const unlimited = (PLANS[wallet.plan] ?? PLANS.free).unlimited;
  const { price, listPrice, freeLeft } = priceFor(await usedTurnImages(wallet.id, db), unlimited);
  return { price, listPrice, freeLeft, unlimited, balance, affordable: balance >= price };
}

export interface TurnImageCharge {
  userId: string;
  referenceId: string;
  /** Mushies taken (0 while free or on an unlimited plan). */
  price: number;
  unlimited: boolean;
  /** Free pictures left after this one. */
  freeLeft: number;
  balance: number;
}

/** Takes payment for one draw before it runs: a 0 row while free, the list
 *  price after. `charge` is null when the player can't pay. `drawId` must be
 *  new for every draw. */
export async function reserveTurnImage(userId: string, drawId: string): Promise<{ charge: TurnImageCharge } | { charge: null; price: number; balance: number }> {
  const referenceId = `${REF_PREFIX}${drawId}`;
  const { wallet } = await checkBalance(userId); // creates the wallet if missing
  const unlimited = (PLANS[wallet.plan] ?? PLANS.free).unlimited;
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(creditWallets).where(eq(creditWallets.id, wallet.id)).for("update");
    if (!locked) throw new Error("WALLET_MISSING");
    const { price, freeLeft } = priceFor(await usedTurnImages(locked.id, tx), unlimited);
    if (price > 0) {
      try {
        const { newBalance } = await deductCredits(userId, price, referenceId, "Illustrated reply", tx);
        return { charge: { userId, referenceId, price, unlimited, freeLeft, balance: newBalance } };
      } catch (error) {
        if (error instanceof Error && error.message === "INSUFFICIENT_CREDITS") {
          return { charge: null, price, balance: (error as { balance?: number }).balance ?? locked.balance };
        }
        throw error;
      }
    }
    await insertHashedTransaction({
      walletId: locked.id,
      amount: 0,
      type: "usage",
      balanceAfter: locked.balance,
      description: unlimited ? "Illustrated reply (plan)" : "Illustrated reply (free)",
      referenceId,
    }, tx);
    return { charge: { userId, referenceId, price: 0, unlimited, freeLeft: unlimited ? freeLeft : Math.max(0, freeLeft - 1), balance: locked.balance } };
  });
}

/** Gives a draw back when its picture didn't land: the mushies, or the free slot. */
export async function refundTurnImage(charge: TurnImageCharge): Promise<void> {
  if (charge.price > 0) {
    await refundCredits(charge.userId, charge.price, charge.referenceId, "Illustrated reply not drawn");
    return;
  }
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, charge.userId)).for("update");
    if (!locked) return;
    await insertHashedTransaction({
      walletId: locked.id,
      amount: 0,
      type: "refund",
      balanceAfter: locked.balance,
      description: "Illustrated reply not drawn",
      referenceId: charge.referenceId,
    }, tx);
  });
}
