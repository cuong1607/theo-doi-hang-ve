// PHẦN 7 — POST /api/zalo/test-message.
//
// admin-only, no arbitrary recipient from the client (recipientId always
// comes from ZALO_TEST_RECIPIENT_ID server env, never the request body —
// this phase does not accept a client-supplied recipient at all), and a
// basic per-process rate limit (see src/lib/zalo/rate-limit.ts for why it's
// intentionally not distributed).
import { NextResponse } from "next/server";

import { authorizeRoute } from "@/lib/auth/session";
import { getZaloTestRecipientId } from "@/lib/zalo/env";
import { sendZaloTextMessage } from "@/lib/zalo/messages";
import { checkRateLimit } from "@/lib/zalo/rate-limit";

export const runtime = "nodejs";

const TEST_MESSAGE_TEXT = "Test kết nối hệ thống Theo dõi hàng về";
const RATE_LIMIT_KEY = "zalo_test_message"; // single fixed key: this is a single-OA admin action, not per-user

export async function POST() {
  const authz = await authorizeRoute("integration:manage");
  if (!authz.ok) return authz.response;

  const rateLimit = checkRateLimit(RATE_LIMIT_KEY);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, errorMessage: "Bạn gửi tin nhắn thử quá nhanh, vui lòng thử lại sau ít phút." },
      { status: 429, headers: rateLimit.retryAfterSeconds ? { "Retry-After": String(rateLimit.retryAfterSeconds) } : undefined }
    );
  }

  let recipientId: string;
  try {
    recipientId = getZaloTestRecipientId();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Thiếu cấu hình người nhận test.";
    return NextResponse.json({ success: false, errorMessage: message }, { status: 500 });
  }

  const result = await sendZaloTextMessage({ recipientId, text: TEST_MESSAGE_TEXT });

  if (!result.success) {
    return NextResponse.json(
      { success: false, errorCode: result.errorCode, errorMessage: result.errorMessage },
      { status: 502 }
    );
  }

  return NextResponse.json({ success: true, message: "Đã gửi tin nhắn test" });
}
