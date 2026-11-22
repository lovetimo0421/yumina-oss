import { eq, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds } from "../db/schema.js";
import { onWorldEvent, publishWorldEvent } from "./world-events.js";
import { notify } from "./notify.js";

/**
 * Who may work on a world in Studio.
 *
 *  - owner: the creator. Everything, including what only the creator may do
 *    (delete, unpublish, visibility and permissions, linking languages,
 *    earnings, managing collaborators).
 *  - editor: an accepted collaborator. Edits the card, runs the assistant,
 *    playtests, restores versions. With `canPublish`, also submits updates.
 *  - viewer: an accepted collaborator who may open the card in Studio and read
 *    everything, but not change it.
 *
 * A grant on one world covers its language variants (same creator, same
 * languageGroupId), since Studio moves between them as one card.
 */
export type WorldRole = "owner" | "editor" | "viewer";

export interface WorldAccess {
  worldId: string;
  creatorId: string;
  languageGroupId: string | null;
  role: WorldRole;
  canPublish: boolean;
}

export const MAX_WORLD_COLLABORATORS = 10;

/**
 * A grant row's status. Only `accepted` gives access, and every access check
 * says so explicitly. `removed` (the creator took them off) and `left` (they
 * walked away) keep the row: an invite link must not let a removed person back
 * in, and the images they put into the card stay protected while it uses them.
 */
export type CollaboratorStatus = "pending" | "accepted" | "removed" | "left";
/** Rows that hold (or wait for) a seat: what the cap counts. */
export const SEAT_STATUSES = ["pending", "accepted"] as const;

type Executor = Pick<typeof db, "select" | "execute">;

/** The grant that lets `userId` into the `worlds` row of the surrounding query. */
function grantSql(userId: string, editorOnly: boolean): SQL {
  return sql`EXISTS (
    SELECT 1 FROM world_collaborators wc JOIN worlds gw ON gw.id = wc.world_id
    WHERE wc.user_id = ${userId} AND wc.status = 'accepted'
      ${editorOnly ? sql`AND wc.role = 'editor'` : sql``}
      AND gw.creator_id = ${worlds.creatorId}
      AND (wc.world_id = ${worlds.id}
        OR (${worlds.languageGroupId} IS NOT NULL AND gw.language_group_id = ${worlds.languageGroupId})))`;
}

/** Where-clause for a `worlds` query: rows `userId` may edit. */
export function canEditWorldSql(userId: string): SQL {
  return or(eq(worlds.creatorId, userId), grantSql(userId, true))!;
}

/** Where-clause for a `worlds` query: rows `userId` may open in Studio (editors and viewers). */
export function canOpenWorldSql(userId: string): SQL {
  return or(eq(worlds.creatorId, userId), grantSql(userId, false))!;
}

/** This person's access to this world, or null when they have none. */
export async function getWorldAccess(userId: string, worldId: string, executor: Executor = db): Promise<WorldAccess | null> {
  const [w] = await executor
    .select({ id: worlds.id, creatorId: worlds.creatorId, languageGroupId: worlds.languageGroupId })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  if (!w) return null;
  const base = { worldId: w.id, creatorId: w.creatorId, languageGroupId: w.languageGroupId ?? null };
  if (w.creatorId === userId) return { ...base, role: "owner", canPublish: true };
  const result = await executor.execute(sql`
    SELECT wc.role, wc.can_publish FROM world_collaborators wc JOIN worlds gw ON gw.id = wc.world_id
    WHERE wc.user_id = ${userId} AND wc.status = 'accepted' AND gw.creator_id = ${w.creatorId}
      AND (wc.world_id = ${w.id} OR (${w.languageGroupId}::text IS NOT NULL AND gw.language_group_id = ${w.languageGroupId}))`);
  const rows = result.rows as Array<{ role: string; can_publish: boolean }>;
  if (rows.length === 0) return null;
  const editor = rows.find((r) => r.role === "editor");
  if (editor) return { ...base, role: "editor", canPublish: rows.some((r) => r.role === "editor" && r.can_publish) };
  return { ...base, role: "viewer", canPublish: false };
}

/**
 * The world and its language variants: every card one grant covers, so the
 * people list, role changes, removals and the cap all see the same set the
 * access check does. Ordered, so callers lock in a stable order.
 */
export async function grantWorldIds(worldId: string, executor: Executor = db): Promise<string[]> {
  const result = await executor.execute(sql`
    SELECT v.id FROM worlds w JOIN worlds v ON v.creator_id = w.creator_id
      AND (v.id = w.id OR (w.language_group_id IS NOT NULL AND v.language_group_id = w.language_group_id))
    WHERE w.id = ${worldId} ORDER BY v.id`);
  return (result.rows as Array<{ id: string }>).map((r) => r.id);
}

/** "user|world" → until when the cursor stream may skip its access check. */
export const cursorAccess = new Map<string, number>();

/** Forget remembered cursor access on a card, so the next cursor call re-checks. */
export function forgetCursorAccess(worldId: string, userId?: string): void {
  for (const key of cursorAccess.keys()) {
    if (userId && userId !== "*" ? key === `${userId}|${worldId}` : key.endsWith(`|${worldId}`)) cursorAccess.delete(key);
  }
}

// Every replica hears access changes (world events travel over Redis), so
// whoever lost access stops reaching the board at once on all of them, not
// after the 15s the cache would otherwise trust.
onWorldEvent((worldId, event) => {
  if (event.kind === "access-changed") forgetCursorAccess(worldId, event.userId);
});

/** Tell every open editor of the card — in each of its languages — that someone's access changed. */
export async function announceAccessChange(worldId: string, userId: string, executor: Executor = db): Promise<void> {
  const at = new Date().toISOString();
  for (const id of await grantWorldIds(worldId, executor)) {
    publishWorldEvent(id, { kind: "access-changed", userId, at });
  }
}

export const canEdit = (access: WorldAccess | null): access is WorldAccess =>
  access?.role === "owner" || access?.role === "editor";

export async function canEditWorld(userId: string, worldId: string, executor: Executor = db): Promise<boolean> {
  return canEdit(await getWorldAccess(userId, worldId, executor));
}

/**
 * May this person's save pull a submitted update back out of review? The
 * creator may, and so may an editor they let publish (they could withdraw it
 * explicitly anyway). Anyone else's routine save must not silently cancel it.
 */
export const mayWithdrawSubmission = (access: Pick<WorldAccess, "role" | "canPublish">): boolean =>
  access.role === "owner" || (access.role === "editor" && access.canPublish);

/**
 * A save by an editor who can't publish, while the creator's update waits in
 * review. Refused instead of withdrawing the submission (see
 * mayWithdrawSubmission); the editor keeps the change unsaved and the UI says
 * why. HTTP 409, code UPDATE_IN_REVIEW.
 */
export class UpdateInReviewError extends Error {
  readonly code = "UPDATE_IN_REVIEW";
  readonly status = 409;
  constructor() {
    super("The owner's update to this card is in review. Your changes can be saved once it is approved or withdrawn.");
    this.name = "UpdateInReviewError";
  }
}

export const updateInReviewBody = () => {
  const e = new UpdateInReviewError();
  return { error: e.message, code: e.code };
};

/**
 * Someone other than the creator pulled the card's submitted update out of
 * review (an editor allowed to publish, by saving or withdrawing). The
 * creator hears it. Fire-and-forget; one notice per person per card per hour.
 */
export function notifySubmissionWithdrawn(args: { worldId: string; creatorId: string; actorId: string }): void {
  if (args.actorId === args.creatorId) return;
  void (async () => {
    const [w] = await db.execute(sql`SELECT w.name AS world_name, u.name AS actor_name FROM worlds w, "user" u
      WHERE w.id = ${args.worldId} AND u.id = ${args.actorId}`).then((r) => r.rows as Array<{ world_name: string; actor_name: string }>);
    await notify(args.creatorId, "world_collab_review_withdrawn", {
      worldId: args.worldId, worldName: w?.world_name ?? "", userId: args.actorId, name: w?.actor_name ?? "",
    }, { actorUserId: args.actorId, dedupeKey: `${args.worldId}:${args.actorId}:withdrawn:${Math.floor(Date.now() / 3_600_000)}` });
  })().catch(() => {});
}

/**
 * Fields of PATCH /api/worlds/:id only the creator may change: who can see
 * and reuse the card, its rating and audience, and which language group it
 * belongs to (and its language, which reshuffles that group). A
 * collaborator's save drops them silently — their editor sends
 * the whole metadata set with every save.
 */
export const OWNER_ONLY_WORLD_FIELDS = [
  "language", "visibility", "targetAudience", "ageRating", "isNsfw", "blurCover", "languageGroupId",
  "allowEdit", "allowCustomApi", "allowReviews", "allowSessionSharing", "allowCommunityCitations",
  "allowLiveCanon", "allowLiveCanonAdditions",
] as const;

/**
 * Library assets of `userId` that a card they work or worked on (but did not
 * create) uses — directly, in its held working copy, or in a language variant
 * the grant covers. Any grant they ever accepted counts, whatever it is now:
 * an editor who left, was removed or was made a viewer may still have images
 * in the card, and deleting them would break it (we don't record who put an
 * image in, so a viewer-only seat counts too). An invite nobody accepted
 * never put anything in the card. Matched by asset id in the stored JSON;
 * bounded by the cards this person collaborates on, so it never scans the
 * whole worlds table.
 *
 * One row per asset. When cards of several creators use it, the creator this
 * person joined first is named; the others keep working, since `@asset:<id>`
 * resolves by id for everyone.
 */
export async function assetsUsedInSharedCards(userId: string, assetId?: string, executor: Executor = db) {
  const result = await executor.execute(sql`
    SELECT DISTINCT ON (ua.id) ua.id, ua.url, w.id AS world_id, w.creator_id, w.name AS world_name
    FROM user_assets ua
    JOIN world_collaborators wc ON wc.user_id = ua.user_id AND (wc.accepted_at IS NOT NULL OR wc.status = 'accepted')
    JOIN worlds gw ON gw.id = wc.world_id
    JOIN worlds w ON w.creator_id = gw.creator_id
      AND (w.id = gw.id OR (gw.language_group_id IS NOT NULL AND w.language_group_id = gw.language_group_id))
    LEFT JOIN world_pending_edits pe ON pe.world_id = w.id
    WHERE ua.user_id = ${userId} AND w.creator_id <> ${userId}
      ${assetId ? sql`AND ua.id = ${assetId}` : sql``}
      AND (strpos(w.schema::text, ua.id) > 0 OR strpos(COALESCE(pe.schema::text, ''), ua.id) > 0)
    ORDER BY ua.id, wc.accepted_at NULLS LAST, w.id`);
  return result.rows as Array<{ id: string; url: string; world_id: string; creator_id: string; world_name: string }>;
}

type HandOverStorage = { copy: (from: string, to: string) => Promise<void>; enabled: boolean };

/** Where a handed-over file lives: under the card, at a fixed path, so copying twice is harmless. */
async function copyHandedOver(row: { id: string; url: string; world_id: string }, storage: HandOverStorage): Promise<string> {
  if (!storage.enabled || !row.url || /^https?:\/\//.test(row.url)) return row.url;
  const target = `worlds/${row.world_id}/handed-over/${row.id}-${row.url.split("/").pop() || row.id}`;
  await storage.copy(row.url, target);
  return target;
}

/**
 * The slow half of a hand-over, run before the deletion transaction: copy the
 * files. Nothing changes owner yet, so a deletion that fails afterwards leaves
 * only spare copies behind. Returns asset id → copied path.
 */
export async function copySharedCardAssets(userId: string, storage: HandOverStorage): Promise<Map<string, string>> {
  const copied = new Map<string, string>();
  for (const row of await assetsUsedInSharedCards(userId)) copied.set(row.id, await copyHandedOver(row, storage));
  return copied;
}

/**
 * Before an account is deleted: every image or sound it put into someone
 * else's card becomes that card's creator's, stored under the card, so the
 * card keeps working after the account and its storage are gone. Cards point
 * at library assets by id (`@asset:<id>`), so moving the row and its file is
 * enough; nothing in the card is rewritten.
 *
 * Run it inside the deletion transaction (pass `tx`), after
 * `copySharedCardAssets`: owners change only if the account really goes.
 * Anything used since the copy pass is copied here.
 */
export async function handOverSharedCardAssets(
  userId: string,
  storage: HandOverStorage,
  executor: Executor = db,
  copied: Map<string, string> = new Map(),
): Promise<number> {
  const rows = await assetsUsedInSharedCards(userId, undefined, executor);
  for (const row of rows) {
    const url = copied.get(row.id) ?? await copyHandedOver(row, storage);
    await executor.execute(sql`
      UPDATE user_assets SET user_id = ${row.creator_id}, url = ${url}, folder_id = NULL
      WHERE id = ${row.id} AND user_id = ${userId}`);
  }
  return rows.length;
}
