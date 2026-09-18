import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../routes/worlds.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pendingEditSource = readFileSync(new URL("./pending-edit.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("world update writes are rate-limited, server-validated, and pending-edit aware", () => {
  const routeStart = source.indexOf('worldRoutes.post("/:id/updates"');
  const routeEnd = source.indexOf('// GET /api/worlds/:id/updates', routeStart);
  const route = source.slice(routeStart, routeEnd);

  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(route, /rateLimitMiddleware\("content-creation"\)/);
  assert.match(route, /parseWorldUpdateNoteBody\(body\)/);
  assert.match(route, /db\.transaction\(async \(tx\)/);
  assert.match(route, /\.for\("update"\)[\s\S]*\.from\(worldPendingEdits\)[\s\S]*WORLD_EDIT_PENDING/);
  assert.ok(route.indexOf(".from(worldPendingEdits)") < route.indexOf(".insert(worldUpdates)"));
  assert.match(route, /try \{[\s\S]*\.from\(userLibrary\)[\s\S]*await notifyMany[\s\S]*catch \(error\)/);
  assert.match(route, /catch \(error\) \{[\s\S]*World update notification fan-out failed/);
});

test("held-edit saves and standalone update notes lock the same world first", () => {
  const saveTransactionStart = source.indexOf("// Apply the held-edit mutation");
  const saveTransactionEnd = source.indexOf("return c.json", saveTransactionStart);
  const saveTransaction = source.slice(saveTransactionStart, saveTransactionEnd);
  const updateRouteStart = source.indexOf('worldRoutes.post("/:id/updates"');
  const updateRouteEnd = source.indexOf("// GET /api/worlds/:id/updates", updateRouteStart);
  const updateRoute = source.slice(updateRouteStart, updateRouteEnd);

  assert.ok(saveTransactionStart >= 0 && saveTransactionEnd > saveTransactionStart);
  assert.ok(updateRouteStart >= 0 && updateRouteEnd > updateRouteStart);
  assert.match(saveTransaction, /\.from\(worlds\)[\s\S]*\.for\("update"\)/);
  assert.ok(saveTransaction.indexOf('.for("update")') < saveTransaction.indexOf("applyHoldPlan"));
  assert.match(updateRoute, /\.from\(worlds\)[\s\S]*\.for\("update"\)/);
  assert.ok(updateRoute.indexOf('.for("update")') < updateRoute.indexOf(".from(worldPendingEdits)"));
});

test("pending update notes cannot be swapped after review submission", () => {
  const functionStart = pendingEditSource.indexOf("export async function setPendingEditUpdateNote");
  const functionEnd = pendingEditSource.indexOf("/**\n * Reject every submitted edit", functionStart);
  const updateNote = pendingEditSource.slice(functionStart, functionEnd);

  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  assert.match(updateNote, /ne\(worldPendingEdits\.status, "pending"\)/);
  assert.match(updateNote, /EXISTS \([\s\S]*w\.creator_id = \$\{creatorId\}/);
  assert.match(updateNote, /\.returning\(\)/);
});

test("world update reads protect visibility, aggregate safe variants, and paginate", () => {
  const routeStart = source.indexOf('worldRoutes.get("/:id/updates"');
  const routeEnd = source.indexOf('worldRoutes.get("/:id/in-library"', routeStart);
  const route = source.slice(routeStart, routeEnd);

  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(route, /optionalAuthMiddleware/);
  assert.match(route, /currentUser \? await readOwn\(currentUser\.id\) : await readDb\(\)/);
  assert.match(route, /canReadWorldUpdateHistory\(\{/);
  assert.match(route, /\.from\(follows\)[\s\S]*follows\.followerId[\s\S]*follows\.followingId/);
  assert.match(route, /w\.language_group_id = \(SELECT language_group_id FROM worlds WHERE id = \$\{worldId\}\)/);
  assert.match(route, /w\.creator_id = \(SELECT creator_id FROM worlds WHERE id = \$\{worldId\}\)/);
  assert.match(route, /w\.status = 'published'/);
  assert.match(route, /\$\{canReadRestricted\} OR w\.visibility = 'public'/);
  assert.match(route, /creatorName: user\.name/);
  assert.match(route, /\.innerJoin\(worlds, eq\(worldUpdates\.worldId, worlds\.id\)\)/);
  assert.match(route, /\.leftJoin\(user, eq\(worlds\.creatorId, user\.id\)\)/);
  assert.match(route, /\.limit\(WORLD_UPDATE_PAGE_SIZE \+ 1\)[\s\S]*\.offset\(offset\)/);
  assert.match(route, /hasMoreWorldUpdates\(rows\.length, offset\)/);
  assert.match(route, /hasMore[\s\S]*nextOffset/);
  assert.match(route, /currentUser \? "private, no-store"/);
  assert.match(route, /c\.header\("Vary", "Cookie"\)/);
});
