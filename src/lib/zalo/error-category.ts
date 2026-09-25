// PHASE ZL7 (Phần 4 — ERROR HANDLING): best-effort classification of a
// notification failure into a handful of actionable buckets, so the admin
// log UI can show something more useful than a raw provider error code.
//
// Two tiers of confidence here, kept explicit in the comments:
// - Our OWN internal error codes (network_error, timeout, not_connected,
//   ...) are 100% reliable — we assign them ourselves in
//   src/lib/zalo/{token,messages,client}.ts.
// - Zalo's own numeric OpenAPI error codes are mapped from commonly-cited
//   community/SDK sources, the same way ZL1 flagged the endpoint URLs
//   (developers.zalo.me is a JS-rendered SPA that couldn't be scraped at
//   implementation time). If a mapping below turns out wrong, the only
//   consequence is a mislabeled category badge in the UI — it never
//   affects whether a message actually sends, what gets logged, or dedupe/
//   retry correctness, all of which key off the raw errorCode instead.
export type ZaloErrorCategory =
  | "auth_error"
  | "invalid_recipient"
  | "recipient_unreachable"
  | "rate_limit"
  | "provider_temporary_error"
  | "unknown";

export const ZALO_ERROR_CATEGORY_LABELS: Record<ZaloErrorCategory, string> = {
  auth_error: "Lỗi xác thực (token)",
  invalid_recipient: "Người nhận không hợp lệ",
  recipient_unreachable: "Người nhận không thể nhận tin",
  rate_limit: "Vượt giới hạn tần suất",
  provider_temporary_error: "Lỗi tạm thời từ Zalo",
  unknown: "Chưa phân loại",
};

// Our own internal codes (see getValidZaloAccessToken/refreshZaloAccessToken
// in token.ts, zaloFetch in client.ts, sendZaloTextMessage in messages.ts).
const INTERNAL_CODE_CATEGORIES: Record<string, ZaloErrorCategory> = {
  not_connected: "auth_error",
  no_refresh_token: "auth_error",
  decrypt_failed: "auth_error",
  invalid_input: "invalid_recipient",
  network_error: "provider_temporary_error",
  invalid_response: "provider_temporary_error",
  unexpected_error: "provider_temporary_error",
  log_insert_failed: "unknown",
};

// Zalo OpenAPI numeric error codes — best-effort, see module doc comment.
const ZALO_NUMERIC_CODE_CATEGORIES: Record<string, ZaloErrorCategory> = {
  "-201": "auth_error", // access token expired/invalid
  "-124": "auth_error", // access token invalid
  "-216": "auth_error", // access token does not belong to this OA
  "-213": "invalid_recipient", // user_id does not exist / never interacted with the OA
  "-214": "recipient_unreachable", // user has blocked messages from the OA
  "-32": "rate_limit", // request rate exceeded
};

export function categorizeZaloError(errorCode: string | null | undefined): ZaloErrorCategory {
  if (!errorCode) return "unknown";
  if (errorCode in INTERNAL_CODE_CATEGORIES) return INTERNAL_CODE_CATEGORIES[errorCode];
  if (errorCode in ZALO_NUMERIC_CODE_CATEGORIES) return ZALO_NUMERIC_CODE_CATEGORIES[errorCode];

  // A bare HTTP status code (client.ts falls back to response.status when
  // Zalo's own `error` field is absent) — 5xx is transient, 4xx besides
  // 401/429 (handled above via Zalo's own codes) is unclassified.
  const asHttpStatus = Number(errorCode);
  if (Number.isInteger(asHttpStatus)) {
    if (asHttpStatus === 401) return "auth_error";
    if (asHttpStatus === 429) return "rate_limit";
    if (asHttpStatus >= 500) return "provider_temporary_error";
  }

  return "unknown";
}
