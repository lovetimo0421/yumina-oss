import assert from "node:assert/strict";
import test from "node:test";

await import("../../test/database-fixture.js");
const { db } = await import("../../db/index.js");
const { assets, user, userAssets, worlds } = await import("../../db/schema.js");
const vision = await import("./asset-vision.js");
const { assetViewTurn, isHarnessTurn } = await import("./harness-notes.js");
type Candidate = import("./asset-vision.js").AssetCandidate;
type ChatMessage = import("../llm/types.js").ChatMessage;

const ME = "user-me";
const WORLD = "world-mine";
const SEES = "qwen/qwen3-vl-235b-a22b-instruct";
const BLIND = "deepseek/deepseek-v4-pro";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { userId: ME, worldId: WORLD };

const lib = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  id: id(n), source: "library", ownerUserId: ME, worldId: null, type: "image", filename: `pic${n}.png`,
  key: `users/${ME}/image/pic${n}.png`, mimeType: "image/png", sizeBytes: 200_000, ...over,
});

test("@asset refs are read once each, in order, and malformed ones are ignored", () => {
  assert.deepEqual(
    vision.assetRefIds(`see @asset:${id(2)} and @asset:${id(1).toUpperCase()}, again @asset:${id(2)}; not @asset:abc or @asset:${id(3)}x`),
    [id(2), id(1), id(3)],
  );
  assert.equal(vision.parseAssetRef(`@asset:${id(4)}`), id(4));
  assert.equal(vision.parseAssetRef(id(4)), id(4));
  assert.equal(vision.parseAssetRef("https://evil.example/x.png"), null);
  assert.equal(vision.parseAssetRef("users/me/image/x.png"), null);
});

test("only this creator's files are shown; anyone else's reads as missing", () => {
  const looks = vision.judgeAssets(
    [id(1), id(2), id(3), id(4)],
    [
      lib(1),
      lib(2, { ownerUserId: "someone-else" }),
      { ...lib(3), source: "card", ownerUserId: null, worldId: "another-world", key: "worlds/another-world/x.png" },
      { ...lib(4), source: "card", ownerUserId: null, worldId: WORLD, key: `worlds/${WORLD}/bg.png` },
    ],
    scope,
    { room: 5, origin: "http://localhost:3000" },
  );
  assert.deepEqual(looks.map((l) => (l.ok ? "shown" : l.reason)), ["shown", "not_found", "not_found", "shown"]);
  assert.equal((looks[0] as { url: string }).url, `http://localhost:3000/cdn/key/${Buffer.from(`users/${ME}/image/pic1.png`).toString("base64url")}`);
  // A foreign file's name never reaches the model either.
  assert.equal(looks[1]!.ok === false && looks[1]!.filename, undefined);
});

test("non-pictures, unreadable formats, outside URLs, oversize files and the cap are skipped with a reason", () => {
  const looks = vision.judgeAssets(
    [id(1), id(2), id(3), id(4), id(5), id(6), id(7)],
    [
      lib(1, { type: "audio", mimeType: "audio/mpeg", key: "users/me/audio/a.mp3" }),
      lib(2, { mimeType: "image/svg+xml", key: "users/me/image/a.svg" }),
      lib(3, { key: "https://evil.example/x.png" }),
      lib(4, { key: "private/secret.png" }),
      lib(5, { sizeBytes: 11 * 1024 * 1024 }),
      lib(6),
      lib(7),
    ],
    scope,
    { room: 1 },
  );
  assert.deepEqual(looks.map((l) => (l.ok ? "shown" : l.reason)),
    ["not_image", "unsupported_format", "unsupported_format", "unsupported_format", "too_large", "shown", "over_limit"]);
});

test("a model that cannot read images gets a note instead of a picture", () => {
  const [look] = vision.judgeAssets([id(1)], [lib(1)], scope, { room: 5, modelSeesImages: vision.modelSeesImages(BLIND) });
  assert.equal(look!.ok, false);
  assert.match(vision.lookLabel(look!), /cannot see pictures/);
});

test("behind Cloudflare the model gets an edge-scaled copy of our own /cdn file", () => {
  const url = vision.modelImageUrl("users/u/image/bg.png", "https://yumina.io")!;
  assert.ok(url.startsWith("https://yumina.io/cdn-cgi/image/width=1568,height=1568,fit=scale-down,"), url);
  assert.ok(url.endsWith(`/cdn/key/${Buffer.from("users/u/image/bg.png").toString("base64url")}`), url);
  assert.ok(!url.includes("format="), "no format negotiation: a provider fetcher must not get AVIF");
  assert.equal(vision.modelImageUrl("http://169.254.169.254/latest", "https://yumina.io"), null);
  assert.equal(vision.modelImageUrl("users/../secret.png", "https://yumina.io"), null);
});

test("the creator's message keeps its words and gains the pictures, attachments counted", async () => {
  const load = async () => [lib(1), lib(2)];
  const plain: ChatMessage = { role: "user", content: "no refs here" };
  assert.equal(await vision.expandAssetRefs(plain, scope, { model: SEES, load }), plain);

  const out = await vision.expandAssetRefs({ role: "user", content: `does @asset:${id(1)} suit the UI? also @asset:${id(9)}` }, scope,
    { model: SEES, load, origin: "http://localhost:3000" });
  assert.ok(Array.isArray(out.content));
  const parts = out.content as Exclude<ChatMessage["content"], string>;
  assert.deepEqual(parts[0], { type: "text", text: `does @asset:${id(1)} suit the UI? also @asset:${id(9)}` });
  assert.equal(parts.filter((p) => p.type === "image_url").length, 1);
  assert.ok(parts.some((p) => p.type === "text" && p.text.includes(id(9)) && p.text.includes("not a file")));

  const attached: ChatMessage = { role: "user", content: [
    { type: "text", text: `@asset:${id(1)} @asset:${id(2)}` },
    ...Array.from({ length: 4 }, (_, i) => ({ type: "image_url" as const, image_url: { url: `https://yumina.io/cdn/key/a${i}` } })),
  ] };
  const capped = await vision.expandAssetRefs(attached, scope, { model: SEES, load });
  assert.equal((capped.content as Exclude<ChatMessage["content"], string>).filter((p) => p.type === "image_url").length, vision.MAX_MESSAGE_IMAGES);
});

test("view_asset takes refs only, never a URL, and respects its caps", async () => {
  const load = async () => [lib(1), lib(2)];
  const url = await vision.viewAssets({ assets: ["https://evil.example/x.png"] }, scope, { model: SEES, viewedThisRun: 0, load });
  assert.match(url.error!, /not an @asset ref/);
  const many = await vision.viewAssets({ assets: [1, 2, 3, 4, 5].map((n) => `@asset:${id(n)}`) }, scope, { model: SEES, viewedThisRun: 0, load });
  assert.match(many.error!, /At most 4/);
  const full = await vision.viewAssets({ assets: [`@asset:${id(1)}`, id(2)] }, scope, { model: SEES, viewedThisRun: vision.MAX_VIEWS_PER_RUN - 1, load });
  assert.deepEqual(full.looks.map((l) => (l.ok ? "shown" : l.reason)), ["shown", "over_limit"]);
});

test("the pictures view_asset shows are the loop's turn, not the creator's", () => {
  const turn = assetViewTurn(vision.lookParts([{ ref: `@asset:${id(1)}`, ok: true, filename: "bg.png", url: "https://yumina.io/cdn/key/x" }]));
  assert.ok(isHarnessTurn(turn));
  assert.ok(!isHarnessTurn({ role: "user", content: [{ type: "text", text: "hello" }] }));
});

test("the database lookup returns only my library and this card's files", async () => {
  const me = crypto.randomUUID(), other = crypto.randomUUID();
  await db.insert(user).values([
    { id: me, name: "Me", email: `${me}@test.invalid` },
    { id: other, name: "Other", email: `${other}@test.invalid` },
  ]);
  const [mine] = await db.insert(worlds).values({ creatorId: me, name: "Mine", schema: {} }).returning();
  const [theirs] = await db.insert(worlds).values({ creatorId: other, name: "Theirs", schema: {} }).returning();
  const ids = { myLib: crypto.randomUUID(), theirLib: crypto.randomUUID(), myCard: crypto.randomUUID(), theirCard: crypto.randomUUID() };
  await db.insert(userAssets).values([
    { id: ids.myLib, userId: me, type: "image", filename: "mine.png", url: `users/${me}/image/mine.png`, mimeType: "image/png", sizeBytes: 10 },
    { id: ids.theirLib, userId: other, type: "image", filename: "secret.png", url: `users/${other}/image/secret.png`, mimeType: "image/png", sizeBytes: 10 },
  ]);
  await db.insert(assets).values([
    { id: ids.myCard, worldId: mine!.id, type: "image", filename: "bg.webp", url: `worlds/${mine!.id}/bg.webp`, mimeType: "image/webp", sizeBytes: 10 },
    { id: ids.theirCard, worldId: theirs!.id, type: "image", filename: "their-bg.webp", url: `worlds/${theirs!.id}/bg.webp`, mimeType: "image/webp", sizeBytes: 10 },
  ]);
  const myScope = { userId: me, worldId: mine!.id };
  const rows = await vision.loadOwnedAssetCandidates(Object.values(ids), myScope);
  assert.deepEqual(rows.map((r) => r.id).sort(), [ids.myLib, ids.myCard].sort());

  const text = `compare @asset:${ids.myLib} @asset:${ids.theirLib} @asset:${ids.myCard} @asset:${ids.theirCard}`;
  const out = await vision.expandAssetRefs({ role: "user", content: text }, myScope, { model: SEES, origin: "http://localhost:3000" });
  const parts = out.content as Exclude<ChatMessage["content"], string>;
  const urls = parts.flatMap((p) => (p.type === "image_url" ? [p.image_url.url] : []));
  assert.equal(urls.length, 2);
  // Decode the key each URL serves: a base64 prefix match flaked whenever the
  // two random user ids happened to start with the same character.
  const keys = urls.map((u) => Buffer.from(u.split("/cdn/key/")[1] ?? "", "base64url").toString("utf-8"));
  assert.deepEqual(keys.sort(), [`users/${me}/image/mine.png`, `worlds/${mine!.id}/bg.webp`].sort());
  const said = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  assert.ok(!said.includes("secret.png") && !said.includes("their-bg.webp"), "another creator's file names stay hidden");
});
