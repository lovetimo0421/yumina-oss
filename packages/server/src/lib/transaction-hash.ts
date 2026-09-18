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
 * Get the hash of the most recent transaction for a wallet.
 * Returns null if no transactions exist (genesis case).
 */
export async function getLastHash(
  walletId: string,
  database: LedgerDatabase = db,
): Promise<string | null> {
  const [last] = await database
    .select({ hash: creditTransactions.hash })
    .from(creditTransactions)
    .where(eq(creditTransactions.walletId, walletId))
    .orderBy(desc(creditTransactions.createdAt))
    .limit(1);
  return last?.hash ?? null;
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
}, database: LedgerDatabase = db): Promise<{ id: string; hash: string }> {
  const previousHash = await getLastHash(values.walletId, database);
  const id = crypto.randomUUID();
  const createdAt = new Date();

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

  return { id: row!.id, hash: row!.hash! };
}
