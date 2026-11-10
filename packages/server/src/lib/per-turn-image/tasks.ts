import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { turnImageTasks } from "../../db/schema.js";
import { checkBalance } from "../credit-service.js";
import type { LedgerDatabase } from "../transaction-hash.js";
import { refundTurnImage, reserveTurnImage } from "./billing.js";

const controllers = new Map<string, AbortController>();

// A cancellation can arrive first. Its terminal row prevents the delayed
// draw request from charging or submitting work.
export async function startTurnImageTask(id: string, userId: string, messageId: string) {
  await checkBalance(userId);
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(turnImageTasks).values({ id, userId, messageId }).onConflictDoNothing().returning();
    const [task] = await tx.select().from(turnImageTasks).where(eq(turnImageTasks.id, id)).for("update");
    if (!task || task.userId !== userId || task.messageId !== messageId) return { reason: "invalid" } as const;
    if (!inserted.length) return { reason: task.status === "cancelled" ? "cancelled" : "busy" } as const;
    const reserved = await reserveTurnImage(userId, id, tx);
    if (!reserved.charge) {
      await tx.update(turnImageTasks).set({ status: "failed" }).where(eq(turnImageTasks.id, id));
      return { reason: "credits", price: reserved.price, balance: reserved.balance } as const;
    }
    await tx.update(turnImageTasks).set({ charge: reserved.charge }).where(eq(turnImageTasks.id, id));
    return { charge: reserved.charge } as const;
  });
}

export async function cancelTurnImageTask(id: string, userId: string, messageId: string) {
  const status = await db.transaction(async (tx) => {
    await tx.insert(turnImageTasks).values({ id, userId, messageId, status: "cancelled" }).onConflictDoNothing();
    const [task] = await tx.select().from(turnImageTasks).where(eq(turnImageTasks.id, id)).for("update");
    if (!task || task.userId !== userId || task.messageId !== messageId) return "invalid";
    if (task.status === "running") {
      if (task.charge) await refundTurnImage(task.charge, tx);
      await tx.update(turnImageTasks).set({ status: "cancelled" }).where(eq(turnImageTasks.id, id));
    }
    return task.status === "running" ? "cancelled" : task.status;
  });
  if (status === "cancelled") controllers.get(id)?.abort("cancelled");
  return status;
}

// Delivery and cancellation lock the same row. Exactly one wins.
export async function deliverTurnImageTask<T>(id: string, deliver: (tx: LedgerDatabase) => Promise<T | null>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(turnImageTasks).where(eq(turnImageTasks.id, id)).for("update");
    if (task?.status !== "running") return null;
    const result = await deliver(tx);
    if (result === null) return null;
    await tx.update(turnImageTasks).set({ status: "completed" }).where(eq(turnImageTasks.id, id));
    return result;
  });
}

export async function failTurnImageTask(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [task] = await tx.select().from(turnImageTasks).where(eq(turnImageTasks.id, id)).for("update");
    if (task?.status !== "running") return;
    if (task.charge) await refundTurnImage(task.charge, tx);
    await tx.update(turnImageTasks).set({ status: "failed" }).where(eq(turnImageTasks.id, id));
  });
}

export function watchTurnImageTask(id: string): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  controllers.set(id, controller);
  let checking = false;
  const check = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const [task] = await db.select().from(turnImageTasks).where(eq(turnImageTasks.id, id));
      if (task?.status !== "running" || task.expiresAt <= new Date()) controller.abort(task?.status === "cancelled" ? "cancelled" : "unavailable");
    } catch { controller.abort("unavailable"); }
    finally { checking = false; }
  };
  const timer = setInterval(() => { void check(); }, 500);
  timer.unref();
  void check();
  return { signal: controller.signal, close: () => { clearInterval(timer); controllers.delete(id); } };
}

// A crashed replica leaves its charge here. A later read recovers it.
export async function recoverExpiredTurnImages(userId?: string): Promise<void> {
  const rows = await db.select({ id: turnImageTasks.id }).from(turnImageTasks)
    .where(and(eq(turnImageTasks.status, "running"), lt(turnImageTasks.expiresAt, new Date()), userId ? eq(turnImageTasks.userId, userId) : undefined)).limit(100);
  for (const row of rows) await failTurnImageTask(row.id);
}

export function startTurnImageRecovery(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await recoverExpiredTurnImages(); }
    catch (error) { console.error("[PerTurnImage] recovery failed", error instanceof Error ? error.message : error); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
