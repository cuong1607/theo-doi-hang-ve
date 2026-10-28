// ============================================================
// DEV TOOLS — shared READ-ONLY access to the production connection rows
// (used by live-readonly.ts and ads-discovery.ts --prod).
//
//   * NEVER refreshes a token. Shopee refresh tokens are single-use: a refresh
//     from this machine would invalidate the token production holds. When the
//     stored access token is close to expiry the tool stops — production
//     refreshes it on its next sync; run again later.
//   * NEVER writes to the cloud database (SELECT only; API failures are not
//     recorded on the connection).
// ============================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret } from "../../src/lib/security/secrets.ts";
import { TOKEN_REFRESH_BUFFER_SECONDS } from "../../src/lib/channels/shopee/constants.ts";
import { tokenContext, type ShopeeTokenSource } from "../../src/lib/channels/shopee/token.ts";

export function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

export function cloudDb(): SupabaseClient {
  let env: Record<string, string | undefined>;
  try {
    env = parseEnv(readFileSync(path.join(process.cwd(), ".env.cloud.local"), "utf8"));
  } catch {
    fail("Không đọc được .env.cloud.local (URL + service role key của project cloud).");
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail(".env.cloud.local thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.");
  if (/localhost|127\.0\.0\.1/.test(url)) fail(".env.cloud.local đang trỏ về DB local — token shop thật chỉ có trên cloud.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Token source that only READS the production connection. No refresh, no writes. */
export class ReadOnlyTokenSource implements ShopeeTokenSource {
  private readonly db: SupabaseClient;
  private readonly key: Buffer;

  constructor(db: SupabaseClient, key: Buffer) {
    this.db = db;
    this.key = key;
  }

  async getValidAccessToken(shopId: string): Promise<string> {
    const { data, error } = await this.db
      .from("shop_connections")
      .select("shop_id, connection_status, access_token_encrypted, access_token_expires_at")
      .eq("shop_id", shopId)
      .maybeSingle<{ shop_id: string; connection_status: string; access_token_encrypted: string | null; access_token_expires_at: string | null }>();
    if (error) fail(`Không đọc được kết nối shop: ${error.message}`);
    if (!data?.access_token_encrypted || !data.access_token_expires_at) fail(`Shop ${shopId} chưa có access token (trạng thái ${data?.connection_status ?? "không có"}).`);
    const minutesLeft = (new Date(data.access_token_expires_at).getTime() - Date.now()) / 60_000;
    if (minutesLeft * 60 < TOKEN_REFRESH_BUFFER_SECONDS) {
      fail(
        `Access token của prod còn ${Math.max(0, Math.floor(minutesLeft))} phút (< ${TOKEN_REFRESH_BUFFER_SECONDS / 60}). ` +
          "Công cụ này KHÔNG làm mới token (refresh token Shopee dùng 1 lần — làm mới ở đây sẽ làm hỏng kết nối của prod). " +
          "Đợi prod đồng bộ (tự làm mới) rồi chạy lại.",
      );
    }
    try {
      return decryptSecret(data.access_token_encrypted, this.key, tokenContext(data.shop_id, "access_token"));
    } catch {
      fail("Giải mã token thất bại — APP_ENCRYPTION_KEY không phải khóa của production.");
    }
  }

  async recordApiFailure(): Promise<void> {
    // Read-only: never touch the production connection row.
  }
}
