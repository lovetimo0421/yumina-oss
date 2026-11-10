import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditWallets, studioCreditReservations } from "../db/schema.js";
import { expireWalletBonus } from "./free-credit-policy.js";
import type { LedgerDatabase } from "./transaction-hash.js";
import { requireVoiceBilling, voiceCreditHoldsProtected } from "../db/voice-billing.js";
export { voiceCreditHoldsProtected } from "../db/voice-billing.js";
export const creditHoldProtectionEnabled = () => studioCreditReservationsEnabled() || voiceCreditHoldsProtected();

export const STUDIO_CREDIT_LEASE_MS = 5 * 60_000;
const MAX_LEASE_MS = 30 * 60_000;

/** Enable only after the reservation table and recovery consumers are deployed. */
export function studioCreditRecoveryEnabled(): boolean {
  return process.env.STUDIO_CREDIT_RECOVERY_ENABLED === "true";
}

/** Roll out to every spending instance before enabling new Studio holds. Keep
 * enabled while recovery is disabled so outstanding leases remain protected. */
export function studioCreditReservationsEnabled(): boolean {
  return studioCreditRecoveryEnabled() || process.env.STUDIO_CREDIT_RESERVATIONS_ENABLED === "true";
}

function leaseExpiry(ttlMs = STUDIO_CREDIT_LEASE_MS): Date {
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_LEASE_MS) {
    throw new Error("INVALID_CREDIT_LEASE");
  }
  return new Date(Date.now() + ttlMs);
}

/** Call under the wallet row lock when making a spending decision. Expired
 * leases immediately stop withholding balance, even if no cleanup job runs. */
export async function heldCreditsForWallet(walletId: string, database: LedgerDatabase, now = new Date()): Promise<number> {
  if(!studioCreditReservationsEnabled()) {
    const probe=await database.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='studio_credit_reservations' AND c.relkind='r') AS ready`);
    if(!(probe as {rows:Record<string,unknown>[]}).rows[0]?.ready)return heldVoiceCreditsForWallet(walletId,database,now);
  }
  const [row] = await database.select({
    held: sql<number>`coalesce(sum(${studioCreditReservations.credits}::numeric), 0)`,
  }).from(studioCreditReservations).where(and(
    eq(studioCreditReservations.walletId, walletId),
    eq(studioCreditReservations.status, "active"),
    gt(studioCreditReservations.expiresAt, now),
  ));
  return Number(row?.held ?? 0) + await heldVoiceCreditsForWallet(walletId,database,now);
}

/** Called only under the wallet lock. A financial expiry never closes a call. */
export async function heldVoiceCreditsForWallet(walletId:string,database:LedgerDatabase,_now=new Date()):Promise<number> {
  if(!voiceCreditHoldsProtected())return 0;
  await requireVoiceBilling(database);
  const result=await database.execute(sql`SELECT coalesce(sum(hold_minor::numeric)/10,0) AS held FROM voice_calls WHERE wallet_id=${walletId} AND hold_minor>0 AND hold_until>clock_timestamp()`);
  return Number((result as unknown as {rows:Array<{held:string}>}).rows[0]?.held??0);
}
/** Ordinary spend does not query Studio tables when its guard is disabled. */
export async function protectedCreditsForWallet(walletId:string,database:LedgerDatabase,now=new Date()):Promise<number> {
  return studioCreditReservationsEnabled()?heldCreditsForWallet(walletId,database,now):heldVoiceCreditsForWallet(walletId,database,now);
}

/** For direct wallet debits such as gifts. The caller holds the wallet lock,
 * then uses this floor both in funding allocation and the guarded UPDATE.
 * Floors overlap: keep at least the gift-policy floor AND all active holds. */
export async function spendFloorWithStudioReservations(walletId: string, floor: number, database: LedgerDatabase): Promise<number> {
  return creditHoldProtectionEnabled() ? Math.max(floor, await protectedCreditsForWallet(walletId, database)) : floor;
}

export async function getAvailableCredits(userId: string, database: LedgerDatabase = db): Promise<{
  balance: number; reservedCredits: number; availableCredits: number;
}> {
  return database.transaction(async (tx) => {
    await expireWalletBonus(userId, tx);
    const [wallet] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, userId)).for("update");
    if (!wallet) throw new Error("WALLET_MISSING");
    const reservedCredits = await heldCreditsForWallet(wallet.id, tx);
    return { balance: wallet.balance, reservedCredits, availableCredits: Math.max(0, wallet.balance - reservedCredits) };
  });
}

export interface StudioCreditReservation {
  id: string;
  credits: number;
  expiresAt: Date;
  availableCredits: number;
}

/** Atomic with ordinary chat deductions: both take the same wallet lock.
 * Holds do not spend or freeze Bonus lots. If funding expires during a run,
 * settlement can require a top-up, but it never revives expired credits. */
export async function reserveStudioCredits(input: {
  userId: string; runId: string; referenceId: string; credits: number; ttlMs?: number;
}, database: LedgerDatabase = db): Promise<StudioCreditReservation> {
  if (!Number.isFinite(input.credits) || input.credits < 0 || !input.referenceId || !input.runId) {
    throw new Error("INVALID_CREDIT_RESERVATION");
  }
  // Round upward to the same tenth-credit unit used by final billing.
  const credits = Math.ceil(input.credits * 10) / 10;
  if (!Number.isFinite(credits)) throw new Error("INVALID_CREDIT_RESERVATION");
  const expiresAt = leaseExpiry(input.ttlMs);
  return database.transaction(async (tx) => {
    await expireWalletBonus(input.userId, tx);
    const [wallet] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, input.userId)).for("update");
    if (!wallet) throw new Error("INSUFFICIENT_CREDITS");
    const [prior] = await tx.select().from(studioCreditReservations).where(and(
      eq(studioCreditReservations.walletId, wallet.id), eq(studioCreditReservations.referenceId, input.referenceId),
    ));
    if (prior?.runId !== undefined && prior.runId !== input.runId) throw new Error("CREDIT_RESERVATION_MISMATCH");
    if (prior?.status === "settled") throw new Error("CREDIT_RESERVATION_ALREADY_SETTLED");
    const now = new Date();
    const held = await heldCreditsForWallet(wallet.id, tx, now);
    const ownHeld = prior?.status === "active" && prior.expiresAt > now ? prior.credits : 0;
    const available = Math.max(0, wallet.balance - held + ownHeld);
    if (credits > available) throw Object.assign(new Error("INSUFFICIENT_CREDITS"), { balance: available, credits });
    const values = { credits, status: "active", expiresAt, updatedAt: now };
    const [reservation] = prior
      ? await tx.update(studioCreditReservations).set(values).where(eq(studioCreditReservations.id, prior.id)).returning()
      : await tx.insert(studioCreditReservations).values({ ...values, walletId: wallet.id, runId: input.runId, referenceId: input.referenceId }).returning();
    return { id: reservation!.id, credits: reservation!.credits, expiresAt: reservation!.expiresAt, availableCredits: Math.max(0, available - reservation!.credits) };
  });
}

/** A missed lease cannot silently reacquire funds already spent elsewhere. */
export async function renewStudioCreditReservation(userId: string, reservationId: string, ttlMs = STUDIO_CREDIT_LEASE_MS, database: LedgerDatabase = db): Promise<boolean> {
  const expiresAt = leaseExpiry(ttlMs);
  return database.transaction(async (tx) => {
    await expireWalletBonus(userId, tx);
    const [wallet] = await tx.select().from(creditWallets).where(eq(creditWallets.userId, userId)).for("update");
    if (!wallet || wallet.balance < await heldCreditsForWallet(wallet.id, tx)) return false;
    const rows = await tx.update(studioCreditReservations).set({ expiresAt, updatedAt: new Date() }).where(and(
      eq(studioCreditReservations.id, reservationId), eq(studioCreditReservations.walletId, wallet.id),
      eq(studioCreditReservations.status, "active"), gt(studioCreditReservations.expiresAt, new Date()),
    )).returning();
    return rows.length > 0;
  });
}

export async function releaseStudioCreditReservation(userId: string, reservationId: string, database: LedgerDatabase = db): Promise<void> {
  await database.transaction(async (tx) => {
    const [wallet] = await tx.select({ id: creditWallets.id }).from(creditWallets).where(eq(creditWallets.userId, userId)).for("update");
    if (!wallet) return;
    await tx.update(studioCreditReservations).set({ status: "released", updatedAt: new Date() }).where(and(
      eq(studioCreditReservations.id, reservationId), eq(studioCreditReservations.walletId, wallet.id), eq(studioCreditReservations.status, "active"),
    ));
  });
}
