// ============================================================
// PHASE SHOPEE-1: validated Shopee configuration (server-only by
// convention — no NEXT_PUBLIC_*; never import from a Client Component).
//
// Reads an env object (process.env by default) so tests can pass their own.
// Errors name the missing/invalid VARIABLE, never its value.
// ============================================================
import { parseEncryptionKey, SecretKeyError } from "../../security/secrets.ts";
import { SHOPEE_PRODUCTION_BASE_URL } from "./constants.ts";

export interface ShopeeConfig {
  partnerId: number;
  partnerKey: string;
  apiBaseUrl: string;
  /** Callback URL registered with Shopee (domain must match the app's console). */
  redirectUrl: string;
  encryptionKey: Buffer;
}

export class ShopeeConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Cấu hình Shopee chưa đúng: ${problems.join("; ")}`);
    this.name = "ShopeeConfigError";
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function getShopeeConfig(env: Env = process.env): ShopeeConfig {
  const problems: string[] = [];

  const partnerIdRaw = env.SHOPEE_PARTNER_ID?.trim();
  let partnerId = 0;
  if (!partnerIdRaw) problems.push("thiếu SHOPEE_PARTNER_ID");
  else if (!/^\d+$/.test(partnerIdRaw) || !Number.isSafeInteger(Number(partnerIdRaw)) || Number(partnerIdRaw) <= 0) {
    problems.push("SHOPEE_PARTNER_ID phải là số nguyên dương");
  } else partnerId = Number(partnerIdRaw);

  const partnerKey = env.SHOPEE_PARTNER_KEY?.trim() ?? "";
  if (!partnerKey) problems.push("thiếu SHOPEE_PARTNER_KEY");

  const apiBaseUrl = stripTrailingSlash(env.SHOPEE_API_BASE_URL?.trim() || SHOPEE_PRODUCTION_BASE_URL);
  if (!isHttpUrl(apiBaseUrl)) problems.push("SHOPEE_API_BASE_URL không phải URL hợp lệ");

  const appUrl = env.APP_URL?.trim();
  const redirectUrl = env.SHOPEE_REDIRECT_URL?.trim() || (appUrl ? `${stripTrailingSlash(appUrl)}/api/shopee/auth/callback` : "");
  if (!redirectUrl) problems.push("thiếu SHOPEE_REDIRECT_URL (hoặc APP_URL để suy ra)");
  else if (!isHttpUrl(redirectUrl)) problems.push("SHOPEE_REDIRECT_URL không phải URL hợp lệ");

  let encryptionKey: Buffer = Buffer.alloc(0);
  try {
    encryptionKey = parseEncryptionKey(env.APP_ENCRYPTION_KEY);
  } catch (err) {
    problems.push(err instanceof SecretKeyError ? err.message : "APP_ENCRYPTION_KEY không hợp lệ");
  }

  if (problems.length > 0) throw new ShopeeConfigError(problems);
  return { partnerId, partnerKey, apiBaseUrl, redirectUrl, encryptionKey };
}
