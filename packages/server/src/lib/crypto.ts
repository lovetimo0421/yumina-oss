import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { env } from "./env.js";

const ALGORITHM = "aes-256-gcm";

const hashKey = (material: string) => createHash("sha256").update(material).digest();

function deriveKey(): Buffer {
  return hashKey(env.ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET);
}

/** Keys a stored row may have been written with, current first. ENCRYPTION_KEY_PREVIOUS
 *  holds retired material during a rotation, so rows keep decrypting until re-encrypted. */
function decryptionKeys(): Buffer[] {
  const materials = [
    env.ENCRYPTION_KEY,
    ...(env.ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((s) => s.trim()),
    env.BETTER_AUTH_SECRET,
  ].filter((m): m is string => !!m);
  return [...new Set(materials)].map(hashKey);
}

export function encryptApiKey(plaintext: string): {
  encrypted: string;
  iv: string;
  tag: string;
} {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

export function decryptApiKey(encrypted: string, iv: string, tag: string): string | null {
  let lastError: Error | undefined;
  for (const key of decryptionKeys()) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"));
      decipher.setAuthTag(Buffer.from(tag, "hex"));

      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch (err) {
      lastError = err as Error;
    }
  }
  console.error("[Crypto] API key decryption failed:", lastError?.message);
  return null;
}
