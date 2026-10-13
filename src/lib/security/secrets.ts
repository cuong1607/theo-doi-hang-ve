// ============================================================
// PHASE SHOPEE-1: app-layer encryption-at-rest for provider secrets
// (Shopee access/refresh tokens; reusable by future integrations).
//
// AES-256-GCM (authenticated), random 96-bit IV per value, versioned
// output so the format/key can evolve without guessing:
//
//   v1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>
//
// The key is APP_ENCRYPTION_KEY: exactly 32 random bytes, base64-encoded
// (`openssl rand -base64 32`). It is NOT a passphrase — a short/human key is
// rejected instead of being stretched.
//
// `context` is bound as GCM additional authenticated data (AAD): a value
// encrypted for "shop_connections:<shop>:access_token" fails to decrypt
// under any other context, so a ciphertext copied onto another shop's row
// (or swapped between the access/refresh columns) is rejected, not used.
//
// Pure Node crypto, no "server-only" marker so `node --test` can import it;
// nothing under src/app/**/*.tsx may import this module.
// ============================================================
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

export class SecretDecryptError extends Error {
  constructor(message = "Không giải mã được dữ liệu bí mật (sai khóa, sai ngữ cảnh hoặc dữ liệu bị sửa).") {
    super(message);
    this.name = "SecretDecryptError";
  }
}

/** Parses + validates a base64 32-byte key. Never echoes the key in errors. */
export function parseEncryptionKey(raw: string | undefined, envName = "APP_ENCRYPTION_KEY"): Buffer {
  if (!raw) throw new SecretKeyError(`Thiếu biến môi trường ${envName}.`);
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretKeyError(`${envName} phải là ${KEY_BYTES} byte ngẫu nhiên dạng base64 (openssl rand -base64 32).`);
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(stored: string, key: Buffer, context: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptError("Định dạng dữ liệu mã hóa không được hỗ trợ.");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64url"), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretDecryptError();
  }
}
