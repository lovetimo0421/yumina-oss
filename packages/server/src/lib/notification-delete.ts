import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";

export async function deleteNotificationOwnedBy(userId: string, notificationId: string): Promise<boolean> {
  const deleted = await db
    .delete(notifications)
    .where(and(
      eq(notifications.id, notificationId),
      eq(notifications.userId, userId),
    ))
    .returning();

  return deleted.length > 0;
}
