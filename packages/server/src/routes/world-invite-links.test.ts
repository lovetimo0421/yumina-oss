import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { Hono, type Handler } from "hono";
import { db } from "../db/index.js";
import { user, userBlocks, worldCollaborators, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { getWorldAccess, MAX_WORLD_COLLABORATORS } from "../lib/world-collaborators.js";
import type { AppEnv } from "../lib/types.js";
import { worldInviteLinkRoutes } from "./world-invite-links.js";

before(async () => { await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href); });

// Run only through scripts/test-local.mjs (isolated in-memory database).
// The routes are mounted without their session check; `x-test-user` says who calls.
type Method = "GET" | "PUT" | "POST" | "DELETE";
const app = new Hono<AppEnv>();
app.onError((err, c) => c.text(String((err as Error).stack ?? err).slice(0, 600), 500));
app.use("*", async (c, next) => {
  const id = c.req.header("x-test-user")!;
  const [row] = await db.select({ id: user.id, name: user.name, role: user.role }).from(user).where(eq(user.id, id));
  c.set("user", { ...row, image: null } as unknown as AppEnv["Variables"]["user"]);
  await next();
});
for (const r of worldInviteLinkRoutes.routes) {
  if (r.handler === authMiddleware || r.method === "ALL") continue;
  const handlers = worldInviteLinkRoutes.routes.filter((x) => x.method === r.method && x.path === r.path && x.handler !== authMiddleware)
    .map((x) => x.handler as Handler<AppEnv>);
  if (r.handler !== handlers[handlers.length - 1]) continue;
  app.on(r.method, r.path, ...(handlers as [Handler<AppEnv>]));
}
const call = (who: string, method: Method, path: string, body?: unknown) => app.request(path, {
  method, headers: { "x-test-user": who, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
type LinkBody = { data: { link: { token: string; role: string; path: string } | null } };

async function people(...names: string[]) {
  const ids = names.map(() => crypto.randomUUID());
  await db.insert(user).values(ids.map((id, i) => ({ id, name: names[i]!, email: `${id}@test.local`, username: `u${id.slice(0, 8)}` })));
  return ids;
}
async function card(creatorId: string) {
  const [w] = await db.insert(worlds).values({ creatorId, name: "Fog Harbour", status: "draft", schema: {}, language: "en" }).returning();
  return w!.id;
}
async function linkOf(owner: string, worldId: string, role: "editor" | "viewer") {
  const body = await (await call(owner, "PUT", `/worlds/${worldId}/link`, { role })).json() as LinkBody;
  return body.data.link!.token;
}
const rowsOf = (worldId: string, userId: string) => db.select().from(worldCollaborators)
  .where(and(eq(worldCollaborators.worldId, worldId), eq(worldCollaborators.userId, userId)));

describe("card invite links", { concurrency: false }, () => {
  it("the creator turns a link on, changes its role, resets and revokes it; nobody else can", async () => {
    const [owner, peer] = await people("Owner", "Peer");
    const w = await card(owner!);
    assert.equal(((await (await call(owner!, "GET", `/worlds/${w}/link`)).json()) as LinkBody).data.link, null);

    const on = await (await call(owner!, "PUT", `/worlds/${w}/link`, { role: "editor" })).json() as LinkBody;
    assert.equal(on.data.link!.role, "editor");
    assert.match(on.data.link!.token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(on.data.link!.path, `/app/join/${on.data.link!.token}`);

    const reRoled = await (await call(owner!, "PUT", `/worlds/${w}/link`, { role: "viewer" })).json() as LinkBody;
    assert.equal(reRoled.data.link!.token, on.data.link!.token, "changing the role keeps the address");
    assert.equal(reRoled.data.link!.role, "viewer");

    const reset = await (await call(owner!, "POST", `/worlds/${w}/link/reset`)).json() as LinkBody;
    assert.notEqual(reset.data.link!.token, on.data.link!.token);
    assert.equal(reset.data.link!.role, "viewer", "a reset keeps the role");
    assert.equal((await call(peer!, "GET", `/links/${on.data.link!.token}`)).status, 404, "the old address stops working");
    assert.equal((await call(peer!, "GET", `/links/${reset.data.link!.token}`)).status, 200);

    for (const [method, path] of [["GET", `/worlds/${w}/link`], ["PUT", `/worlds/${w}/link`], ["POST", `/worlds/${w}/link/reset`], ["DELETE", `/worlds/${w}/link`]] as const) {
      assert.equal((await call(peer!, method, path, method === "PUT" ? { role: "editor" } : undefined)).status, 403, `${method} ${path}`);
    }

    assert.equal((await call(owner!, "DELETE", `/worlds/${w}/link`)).status, 200);
    assert.equal((await call(peer!, "GET", `/links/${reset.data.link!.token}`)).status, 404, "a revoked link is gone");
    assert.equal((await call(peer!, "POST", `/links/${reset.data.link!.token}/join`)).status, 404);
  });

  it("joining makes an accepted collaborator; the creator's own join changes nothing", async () => {
    const [owner, peer] = await people("Owner", "Peer");
    const w = await card(owner!);
    const token = await linkOf(owner!, w, "editor");
    const preview = await (await call(peer!, "GET", `/links/${token}`)).json() as { data: Record<string, unknown> };
    assert.deepEqual([preview.data.worldId, preview.data.creatorName, preview.data.role, preview.data.alreadyMember], [w, "Owner", "editor", false]);

    const joined = await (await call(peer!, "POST", `/links/${token}/join`)).json() as { data: { worldId: string; role: string } };
    assert.deepEqual(joined.data, { worldId: w, role: "editor" });
    assert.equal((await getWorldAccess(peer!, w))?.role, "editor");
    const [row] = await rowsOf(w, peer!);
    assert.equal(row!.status, "accepted");

    const again = await (await call(peer!, "GET", `/links/${token}`)).json() as { data: Record<string, unknown> };
    assert.deepEqual([again.data.alreadyMember, again.data.myRole], [true, "editor"]);

    const mine = await (await call(owner!, "POST", `/links/${token}/join`)).json() as { data: { worldId: string; role: string } };
    assert.deepEqual(mine.data, { worldId: w, role: "owner" });
    assert.equal((await rowsOf(w, owner!)).length, 0, "the creator never becomes their own collaborator");
  });

  it("a link only seats: a pending invite is accepted, and nobody's role changes", async () => {
    const [owner, invited, viewer, editor] = await people("Owner", "Invited", "Viewer", "Editor");
    const w = await card(owner!);
    await db.insert(worldCollaborators).values([
      { worldId: w, userId: invited!, role: "editor", status: "pending" },
      { worldId: w, userId: viewer!, role: "viewer", status: "accepted", acceptedAt: new Date() },
      { worldId: w, userId: editor!, role: "editor", status: "accepted", acceptedAt: new Date() },
    ]);
    const viewLink = await linkOf(owner!, w, "viewer");
    await call(invited!, "POST", `/links/${viewLink}/join`);
    assert.deepEqual((await rowsOf(w, invited!)).map((r) => [r.role, r.status]), [["editor", "accepted"]], "the higher role of invite and link");
    await call(editor!, "POST", `/links/${viewLink}/join`);
    assert.equal((await rowsOf(w, editor!))[0]!.role, "editor", "a view link never lowers an editor");

    const editLink = await linkOf(owner!, w, "editor");
    assert.equal(editLink, viewLink, "same address, new role");
    const joined = await (await call(viewer!, "POST", `/links/${editLink}/join`)).json() as { data: { role: string } };
    assert.equal(joined.data.role, "viewer");
    assert.equal((await rowsOf(w, viewer!))[0]!.role, "viewer", "a viewer the creator chose (or lowered) stays one, even through an editor link");
  });

  it("someone the creator removed can't come back through the link until invited again; someone who left can", async () => {
    const [owner, removed, left] = await people("Owner", "Removed", "Left");
    const w = await card(owner!);
    await db.insert(worldCollaborators).values([
      { worldId: w, userId: removed!, role: "viewer", status: "removed", acceptedAt: new Date() },
      { worldId: w, userId: left!, role: "editor", status: "left", acceptedAt: new Date() },
    ]);
    const token = await linkOf(owner!, w, "editor");
    const preview = await (await call(removed!, "GET", `/links/${token}`)).json() as { data: Record<string, unknown> };
    assert.equal(preview.data.removed, true);
    const refused = await call(removed!, "POST", `/links/${token}/join`);
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { code: string }).code, "REMOVED_BY_OWNER");
    assert.equal(await getWorldAccess(removed!, w), null);
    assert.deepEqual((await rowsOf(w, removed!)).map((r) => r.status), ["removed"]);

    const back = await call(left!, "POST", `/links/${token}/join`);
    assert.equal(back.status, 200);
    assert.deepEqual((await rowsOf(w, left!)).map((r) => [r.role, r.status]), [["editor", "accepted"]]);
  });

  it("a full card and a blocked person are refused", async () => {
    const [owner, outsider, blocked] = await people("Owner", "Outsider", "Blocked");
    const w = await card(owner!);
    const token = await linkOf(owner!, w, "viewer");
    const crowd = await people(...Array.from({ length: MAX_WORLD_COLLABORATORS }, (_, i) => `P${i}`));
    await db.insert(worldCollaborators).values(crowd.map((userId) => ({ worldId: w, userId, role: "viewer", status: "accepted", acceptedAt: new Date() })));
    const full = await call(outsider!, "POST", `/links/${token}/join`);
    assert.equal(full.status, 409);
    assert.equal(((await full.json()) as { code: string }).code, "TOO_MANY");
    assert.equal((await rowsOf(w, outsider!)).length, 0);

    const w2 = await card(owner!);
    const token2 = await linkOf(owner!, w2, "editor");
    await db.insert(userBlocks).values({ blockerId: owner!, blockedId: blocked! });
    const refused = await call(blocked!, "POST", `/links/${token2}/join`);
    assert.equal(refused.status, 403);
    assert.equal((await rowsOf(w2, blocked!)).length, 0);
  });

  it("a logged-out visitor sees only the card's name, cover, sharer and role; everything else still needs sign-in", async () => {
    const [owner] = await people("Owner");
    const w = await card(owner!);
    const token = await linkOf(owner!, w, "editor");
    // Straight through the router, with its real session check and no cookie.
    const guest = await worldInviteLinkRoutes.request(`/links/${token}`);
    assert.equal(guest.status, 200, await guest.clone().text());
    const body = await guest.json() as { data: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.data).sort(), ["alreadyMember", "creatorName", "myRole", "role", "thumbnailUrl", "worldName"]);
    assert.deepEqual([body.data.worldName, body.data.creatorName, body.data.role, body.data.alreadyMember, body.data.myRole],
      ["Fog Harbour", "Owner", "editor", false, null]);
    assert.equal((await worldInviteLinkRoutes.request("/links/short")).status, 404);
    assert.equal((await worldInviteLinkRoutes.request(`/links/${token}/join`, { method: "POST" })).status, 401);
    assert.equal((await worldInviteLinkRoutes.request(`/worlds/${w}/link`)).status, 401);
  });

  it("a malformed or unknown token is simply gone", async () => {
    const [someone] = await people("Someone");
    assert.equal((await call(someone!, "GET", "/links/short")).status, 404);
    assert.equal((await call(someone!, "GET", `/links/${"x".repeat(32)}`)).status, 404);
  });
});
