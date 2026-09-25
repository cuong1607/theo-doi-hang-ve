// ============================================================
// PHASE ZL1: App-layer encryption-at-rest for tokens stored in
// zalo_connections. See docs/zalo-integration.md's "Token storage
// strategy" for why this is a lightweight AES-256-GCM scheme rather than a
// full secrets-manager integration — the phase spec explicitly allows this
// ("nếu chưa có encryption infrastructure ... không over-engineer").
//
// ZALO_TOKEN_ENCRYPTION_KEY can be any non-empty string (a password, not
// necessarily 32 raw bytes) — it's stretched to a 256-bit key via SHA-256
// so operators don't have to generate/paste a hex-exact key. Ciphertext is
// stored as "ivBase64.authTagBase64.ciphertextBase64" (single text column,
// no separate columns needed for iv/tag).
// Not marked "server-only" — pure Node crypto with no browser-unsafe global
// state, and encrypt/decrypt round-trip is unit tested directly (plain
// `node --test`, same as pkce.ts). Nothing in src/app/**/*.tsx imports this.
// ============================================================
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getZaloEncryptionKey } from "./env.ts";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, standard for GCM

function deriveKey(): Buffer {
  return createHash("sha256").update(getZaloEncryptionKey()).digest();
}

export function encryptToken(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptToken(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 3) {
    throw new Error("Định dạng token đã mã hóa không hợp lệ.");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
