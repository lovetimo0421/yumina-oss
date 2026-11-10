import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";

// Rows written before the rotation: no ENCRYPTION_KEY, key derived from the old auth secret.
const OLD_AUTH = "old-auth-secret-for-rotation-test";
function encryptWith(material: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(material).digest(), iv);
  const encrypted = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
  return { encrypted, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

process.env.BETTER_AUTH_SECRET = "new-auth-secret-for-rotation-test";
process.env.ENCRYPTION_KEY = "new-encryption-key-for-rotation-test";
process.env.ENCRYPTION_KEY_PREVIOUS = OLD_AUTH;
const { encryptApiKey, decryptApiKey } = await import("./crypto.js");

test("rows written under the retired auth secret still decrypt during rotation", () => {
  const old = encryptWith(OLD_AUTH, "sk-legacy-row");
  assert.equal(decryptApiKey(old.encrypted, old.iv, old.tag), "sk-legacy-row");
});

test("new rows are written with ENCRYPTION_KEY, not the previous material", () => {
  const row = encryptApiKey("sk-new-row");
  assert.equal(decryptApiKey(row.encrypted, row.iv, row.tag), "sk-new-row");
  const underCurrent = encryptWith(process.env.ENCRYPTION_KEY!, "probe");
  assert.equal(decryptApiKey(underCurrent.encrypted, underCurrent.iv, underCurrent.tag), "probe");
});

test("material outside every configured key fails closed", () => {
  const foreign = encryptWith("someone-elses-key", "sk-foreign");
  assert.equal(decryptApiKey(foreign.encrypted, foreign.iv, foreign.tag), null);
});
