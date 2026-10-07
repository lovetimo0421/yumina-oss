import { and, eq, ne, or, type SQL } from "drizzle-orm";
import { messages } from "../db/schema.js";

/** Failed actions never happened. Only the active send's exact retried user
 * row may re-enter the prompt; the exception cannot bypass session or memory filters. */
export function buildTurnHistoryFilter(
  sessionId: string,
  historyConditions: SQL[],
  activeUserMessageId?: string,
) {
  return and(
    eq(messages.sessionId, sessionId),
    or(
      ne(messages.status, "failed"),
      activeUserMessageId
        ? and(eq(messages.id, activeUserMessageId), eq(messages.role, "user"))
        : undefined,
    ),
    ...historyConditions,
  );
}
