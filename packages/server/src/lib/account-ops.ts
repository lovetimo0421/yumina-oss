import { desc, eq } from "drizzle-orm";
import { db, readOwn } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import type { ToolDefinition } from "./llm/types.js";
import { syncSearchDocNormalized } from "./normalize-search.js";
import { checkpointWorld } from "./world-version-store.js";
import { CARDS_PER_DAY, canCreateCard } from "./outside-ai-guards.js";

/**
 * Account ops — for an outside AI signed in as the creator (OAuth), not bound
 * to one card. It lists the creator's cards and starts new ones; every card op
 * (lib/world-ops.ts) then names its card with `card_id`.
 */

export const ACCOUNT_OPS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_my_cards",
      description: "The creator's own cards, most recently edited first: id, name, whether published. Pass a card's id as card_id to every other tool.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "create_card",
      description: "Start a new, empty, unpublished card owned by the creator and return its id. Use it when the creator asks for a new card rather than a change to an existing one.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The card's title." } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
];

export async function runAccountOp(args: { userId: string; name: string; input: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const { userId, name, input } = args;
  if (name === "list_my_cards") {
    const rows = await (await readOwn(userId))
      .select({ id: worlds.id, name: worlds.name, status: worlds.status, updatedAt: worlds.updatedAt })
      .from(worlds)
      .where(eq(worlds.creatorId, userId))
      .orderBy(desc(worlds.updatedAt))
      .limit(100);
    return { ok: true, result: rows.map((r) => ({ id: r.id, name: r.name, published: r.status === "published", updatedAt: r.updatedAt })) };
  }
  if (name === "create_card") {
    const title = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
    if (!title) return { ok: false, error: "Give the card a name." };
    const [owner] = await db.select({ isBanned: user.isBanned }).from(user).where(eq(user.id, userId)).limit(1);
    if (!owner || owner.isBanned) return { ok: false, error: "This account cannot create cards." };
    if (!(await canCreateCard(userId))) {
      return { ok: false, error: `Card limit reached: ${CARDS_PER_DAY} new cards a day. Work on an existing card (list_my_cards) or try tomorrow.` };
    }
    const schema = { name: title, entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} };
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx.insert(worlds).values({ name: title, description: "", schema, creatorId: userId, totalTokens: 0 }).returning();
      if (inserted[0]) await checkpointWorld(tx, inserted[0].id, "save");
      return inserted;
    });
    if (!row) return { ok: false, error: "Could not create the card." };
    await syncSearchDocNormalized(db, row.id).catch(() => {});
    return { ok: true, result: { card_id: row.id, name: title } };
  }
  return { ok: false, error: `Unknown tool "${name}".` };
}
