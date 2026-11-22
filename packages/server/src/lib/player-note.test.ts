import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_PLAYER_NOTE_CHARS, normalizePlayerNote, playerNoteMessage, resolveTurnNote, turnNoteRowId, turnPlayerNote } from "./player-note.js";

test("player note: trims, folds blank runs, caps the length, drops non-text", () => {
  assert.equal(normalizePlayerNote("  慢一点，让她先开口  "), "慢一点，让她先开口");
  assert.equal(normalizePlayerNote("a\r\n\r\n\r\n\r\nb"), "a\n\nb");
  assert.equal(normalizePlayerNote("x".repeat(MAX_PLAYER_NOTE_CHARS + 50))?.length, MAX_PLAYER_NOTE_CHARS);
  for (const raw of [undefined, null, "", "   ", 42, { note: "hi" }]) assert.equal(normalizePlayerNote(raw), null);
});

test("player note: the prompt block keeps the player's words and marks them out of character", () => {
  const message = playerNoteMessage("Slow the pacing down.");
  // A trailing system message is hoisted above the story (Gemini, Claude) or
  // skipped (DeepSeek V3.2 hosts); a user turn is read where it sits.
  assert.equal(message.role, "user");
  assert.match(message.content, /Out-of-character direction from the player, for this reply only/);
  assert.ok(message.content.endsWith("\nSlow the pacing down."));
});

test("player note: a regenerated reply follows its own note, else the player's message before it", () => {
  assert.equal(turnPlayerNote({ playerNote: "on the reply" }, { role: "user", playerNote: "on the message" }), "on the reply");
  assert.equal(turnPlayerNote({ playerNote: null }, { role: "user", playerNote: "on the message" }), "on the message");
  assert.equal(turnPlayerNote({}, { role: "assistant", playerNote: "not a player message" }), null);
  assert.equal(turnPlayerNote({}, null), null);
});

test("player note: a re-run keeps the stored note unless the request brings one; a new one replaces it", () => {
  // Regenerate / retry with nothing open in the composer: the turn's own note.
  assert.deepEqual(resolveTurnNote(undefined, "slow down"), { note: "slow down", replaced: false });
  assert.deepEqual(resolveTurnNote("   ", "slow down"), { note: "slow down", replaced: false });
  assert.deepEqual(resolveTurnNote(undefined, null), { note: null, replaced: false });
  // A note open now wins, and the row should take it.
  assert.deepEqual(resolveTurnNote("let her speak first", "slow down"), { note: "let her speak first", replaced: true });
  assert.deepEqual(resolveTurnNote("let her speak first", null), { note: "let her speak first", replaced: true });
  // The same words again: nothing to rewrite.
  assert.deepEqual(resolveTurnNote(" slow down ", "slow down"), { note: "slow down", replaced: false });
});

test("player note: a replacement is saved where turnPlayerNote reads it", () => {
  const reply = { id: "a1", playerNote: null };
  assert.equal(turnNoteRowId(reply, { id: "u1", role: "user" }), "u1");
  assert.equal(turnNoteRowId({ id: "a1", playerNote: "note alone" }, { id: "u1", role: "user" }), "a1");
  assert.equal(turnNoteRowId(reply, { id: "a0", role: "assistant" }), "a1");
  assert.equal(turnNoteRowId(reply, null), "a1");
  // Round trip: once saved on that row, a later swipe reads the new note back.
  const preceding = { id: "u1", role: "user", playerNote: "old" as string | null };
  if (turnNoteRowId(reply, preceding) === preceding.id) preceding.playerNote = "new";
  assert.equal(turnPlayerNote(reply, preceding), "new");
});

// The SSE handlers are integration-heavy; keep the wiring honest at the source.
const route = readFileSync(fileURLToPath(new URL("../routes/messages.ts", import.meta.url)), "utf8");

test("player note: send stores it on the user row (or the reply, for a note alone) and puts it in that prompt", () => {
  assert.match(route, /let playerNote = normalizePlayerNote\(body\.note\);/);
  assert.match(route, /role: "user",\s*content: userContent,[\s\S]{0,300}\.\.\.\(playerNote && \{ playerNote \}\)/);
  assert.match(route, /\.\.\.\(isContinueMode && playerNote && \{ playerNote \}\)/);
  assert.match(route, /const noteMessage = playerNote \? playerNoteMessage\(playerNote\) : null;/);
  assert.match(route, /const suffixCount = [^;]*\(noteMessage \? 1 : 0\)/);
});

test("player note: a retried send keeps the stored note, or saves the one it brings", () => {
  assert.match(route, /playerNote: messages\.playerNote \}\)\s*\.from\(messages\)\s*\.where\(eq\(messages\.sessionId, sessionId\)\)/);
  assert.match(route, /const retried = resolveTurnNote\(body\.note, latest!\.playerNote\);\s*playerNote = retried\.note;/);
  assert.match(route, /if \(retried\.replaced\) \{\s*await db\.update\(messages\)\.set\(\{ playerNote \}\)\.where\(eq\(messages\.id, latest!\.id\)\);/);
});

test("player note: regenerate reads the turn's note back and counts it in the suffix", () => {
  assert.match(route, /const \{ note: regenNote, replaced: regenNoteReplaced \} = resolveTurnNote\(body\.note, turnPlayerNote\(msg,/);
  // A replacement is saved with the new swipe and reported so the bubble shows it.
  assert.match(route, /\.\.\.\(regenNoteRowId === messageId && \{ playerNote: regenNote \}\)/);
  assert.match(route, /if \(regenNoteRowId && regenNoteRowId !== messageId\) \{\s*await tx\.update\(messages\)\.set\(\{ playerNote: regenNote \}\)/);
  assert.match(route, /\.\.\.\(regenNoteRowId && \{ playerNote: \{ messageId: regenNoteRowId, note: regenNote \} \}\)/);
  assert.match(route, /const regenSuffixCount = [^;]*\(regenNoteMessage \? 1 : 0\)/);
});
