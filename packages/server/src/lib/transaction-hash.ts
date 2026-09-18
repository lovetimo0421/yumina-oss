// ─── Transaction Hash Chain ─────────────────────────────────────────
// Blockchain-like tamper-proof ledger for credit transactions.
// Each transaction's hash includes the previous transaction's hash,
// creating an immutable chain. Any modification breaks the chain.

import { createHash } from "crypto";
import { db } from "../db/index.js";
import { creditTransactions } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";

export type LedgerDatabase = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Compute SHA-256 hash for a transaction.
 * Input: id|walletId|amount|type|balanceAfter|previousHash|createdAt
 */
export function computeTransactionHash(fields: {
  id: string;
  walletId: string;
  amount: number;
  type: string;
  balanceAfter: number;
  previousHash: string | null;
  createdAt: string; // ISO string
}): string {
  const payload = [
    fields.id,
    fields.walletId,
    String(fields.amount),
    fields.type,
    String(fields.balanceAfter),
    fields.previousHash ?? "genesis",
    fields.createdAt,
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The most recent link of a wallet's chain: its hash and created_at.
 * Returns null if no transactions exist (genesis case).
 */
export async function getLastChainLink(
  walletId: string,
  database: LedgerDatabase = db,
): Promise<{ hash: string | null; createdAt: Date } | null> {
  const [last] = await database
    .select({ hash: creditTransactions.hash, createdAt: creditTransactions.createdAt })
    .from(creditTransactions)
    .where(eq(creditTransactions.walletId, walletId))
    .orderBy(desc(creditTransactions.createdAt), desc(creditTransactions.id))
    .limit(1);
  return last ? { hash: last.hash ?? null, createdAt: last.createdAt } : null;
}

/**
 * Get the hash of the most recent transaction for a wallet.
 * Returns null if no transactions exist (genesis case).
 */
export async function getLastHash(
  walletId: string,
  database: LedgerDatabase = db,
): Promise<string | null> {
  return (await getLastChainLink(walletId, database))?.hash ?? null;
}

/**
 * Insert a transaction with hash chain integrity.
 * Returns the inserted row.
 */
export async function insertHashedTransaction(values: {
  walletId: string;
  amount: number;
  type: string;
  referenceId?: string | null;
  balanceAfter: number;
  description?: string | null;
  /** Requested timestamp (tests). Still forced strictly after the previous link. */
  createdAt?: Date;
}, database: LedgerDatabase = db): Promise<{ id: string; hash: string; createdAt: Date }> {
  // The chain is ordered by created_at. Several rows written inside one
  // transaction (an upgrade settlement paying two drops and then the grant, a
  // multi-drop release) can share a millisecond, and two rows with the same
  // created_at would each claim the same previous link — a silent fork. Force
  // every new link strictly after the last one. Callers hold the wallet row
  // lock, so the last-link read is authoritative.
  const last = await getLastChainLink(values.walletId, database);
  const previousHash = last?.hash ?? null;
  const id = crypto.randomUUID();
  const requested = values.createdAt ?? new Date();
  const createdAt = last && requested.getTime() <= last.createdAt.getTime()
    ? new Date(last.createdAt.getTime() + 1)
    : requested;

  const hash = computeTransactionHash({
    id,
    walletId: values.walletId,
    amount: values.amount,
    type: values.type,
    balanceAfter: values.balanceAfter,
    previousHash,
    createdAt: createdAt.toISOString(),
  });

  const [row] = await database
    .insert(creditTransactions)
    .values({
      id,
      walletId: values.walletId,
      amount: values.amount,
      type: values.type,
      referenceId: values.referenceId ?? null,
      balanceAfter: values.balanceAfter,
      description: values.description ?? null,
      previousHash,
      hash,
      createdAt,
    })
    .returning();

  return { id: row!.id, hash: row!.hash!, createdAt };
}
