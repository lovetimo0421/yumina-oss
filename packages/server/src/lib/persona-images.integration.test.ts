import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../db/index.js";
import { user, worlds, playSessions, userPersonas, messages } from "../db/schema.js";
import { setAccountPersona, setSessionPersona, setSessionPersonaLock, resolvePersonaForSession } from "./resolve-persona.js";
import { normalizeImageCompletion, validateChatImages, storeChatImages, restoreChatImages, imagePromptChars } from "./chat-images.js";
import { deleteObject } from "./s3.js";
import { PromptBuilder } from "@yumina/engine";

async function fixture() {
  const uid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Image test", email: `${uid}@test.local` });
  const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Test", schema: {} }).returning();
  const sessions = await db.insert(playSessions).values([0, 1].map(() => ({ userId: uid, worldId: world!.id }))).returning();
  return { uid, sessions, cleanup: () => db.delete(user).where(eq(user.id, uid)) };
}

test("game persona selection isolates saves, includes explicit none, follows profile only on unlock", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const [a, b] = await db.insert(userPersonas).values([
      { userId: f.uid, name: "Global", isActive: true }, { userId: f.uid, name: "Local" },
    ]).returning();
    const [foreign] = await db.insert(userPersonas).values({ userId: other.uid, name: "Foreign" }).returning();
    const session = async (id: string) => (await db.select().from(playSessions).where(eq(playSessions.id, id)))[0]!;
    assert.equal((await setSessionPersona(f.uid, f.sessions[0]!.id, b!.id)).data?.persona?.id, b!.id);
    assert.equal((await session(f.sessions[0]!.id)).personaLocked, true);
    assert.equal((await resolvePersonaForSession(await session(f.sessions[0]!.id)))?.id, b!.id);
    assert.equal((await resolvePersonaForSession(await session(f.sessions[1]!.id)))?.id, a!.id);
    assert.equal((await db.select().from(userPersonas).where(eq(userPersonas.id, a!.id)))[0]!.isActive, true);
    assert.equal((await setSessionPersona(f.uid, other.sessions[0]!.id, b!.id)).error, "Session not found");
    assert.equal((await setSessionPersona(f.uid, f.sessions[0]!.id, foreign!.id)).error, "Persona not found");
    await setAccountPersona(f.uid, b!.id);
    assert.equal((await resolvePersonaForSession(await session(f.sessions[1]!.id)))?.id, b!.id);
    await setSessionPersona(f.uid, f.sessions[0]!.id, null);
    assert.equal(await resolvePersonaForSession(await session(f.sessions[0]!.id)), null);
    await setSessionPersonaLock(f.uid, f.sessions[0]!.id, false);
    assert.equal((await resolvePersonaForSession(await session(f.sessions[0]!.id)))?.id, b!.id);
  } finally { await f.cleanup(); await other.cleanup(); }
});

test("image bytes survive persistence, prompt trimming, reload and branch-style copies by message ID", async () => {
  const f = await fixture();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const image = { type: "image" as const, mimeType: "image/png", name: "pasted.png", data: png.toString("base64") };
  const stored = await storeChatImages(f.uid, await validateChatImages([image]));
  try {
    const [first, second] = await db.insert(messages).values([
      { sessionId: f.sessions[0]!.id, role: "user", content: "same text", attachments: stored },
      { sessionId: f.sessions[0]!.id, role: "user", content: "same text" },
    ]).returning();
    const prompt = [{ role: "user" as const, content: "same text", sourceMessageId: first!.id },
      { role: "system" as const, content: "injected lore" },
      { role: "user" as const, content: "same text", sourceMessageId: second!.id }];
    const hydrated = await restoreChatImages(f.sessions[0]!.id, await new PromptBuilder().buildMessageHistoryAsync(prompt, async () => {}, 10000));
    assert.deepEqual(hydrated[0]!.content, [{ type: "text", text: "same text" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } }]);
    assert.equal(hydrated[2]!.content, "same text");
    assert.equal((await restoreChatImages(f.sessions[1]!.id, prompt))[0]!.content, "same text", "No cross-session attachment lookup");
    const [copy] = await db.insert(messages).values({ sessionId: f.sessions[1]!.id, role: "user", content: "", attachments: first!.attachments }).returning();
    const replay = await restoreChatImages(f.sessions[1]!.id, [{ role: "user", content: "", sourceMessageId: copy!.id }]);
    assert.equal(Array.isArray(replay[0]!.content) && replay[0]!.content[0]?.type, "image_url");
    const completion = await normalizeImageCompletion([{ role: "user", content: "same text", attachments: [image] }]);
    assert.deepEqual(completion[0]!.content, hydrated[0]!.content);
    assert.equal(imagePromptChars(completion), 6409);
    const ordered = await normalizeImageCompletion([{ role: "user", content: [
      { type: "text", text: "first" }, { type: "image_url", image_url: { url: stored[0]!.url } },
      { type: "text", text: "second" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
    ] }]);
    assert.equal(Array.isArray(ordered[0]!.content) && ordered[0]!.content[2]?.type, "text");
    await assert.rejects(normalizeImageCompletion([{ role: "user", content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/private" } }] }]));
    await db.update(messages).set({ attachments: [{ type: "image", mimeType: "image/png", name: "legacy", url: "data:image/png;base64,truncated..." }] }).where(eq(messages.id, first!.id));
    const legacy = await restoreChatImages(f.sessions[0]!.id, prompt);
    assert.equal(typeof legacy[0]!.content, "string");
    assert.match(legacy[0]!.content as string, /unavailable/);
    assert.deepEqual((await normalizeImageCompletion([{ role: "user", content: completion[0]!.content }]))[0]!.content, hydrated[0]!.content);
    await assert.rejects(validateChatImages([{ ...image, mimeType: "image/jpeg" }]));
    await assert.rejects(validateChatImages(Array(5).fill(image)));
    await assert.rejects(validateChatImages([{ ...image, data: "not base64" }]));
    await assert.rejects(normalizeImageCompletion([{ role: "system", content: "", attachments: [image] }]));
  } finally { await deleteObject(stored[0]!.storageKey); await f.cleanup(); }
});
