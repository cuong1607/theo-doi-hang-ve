// PHẦN 8 — POST /api/notifications/test-all: admin-only, sends a fixed test
// message to every active notification_recipients row via the shared
// sendNotification() service (never calls sendZaloTextMessage directly from
// here, per the phase spec).
//
// ZL7 Phần 7 ("test 1 recipient"): an optional JSON body
// `{ recipientId: string }` scopes the same test send down to just that
// recipient (via sendNotification's recipientIds filter) — logged under a
// distinct event type (TEST_SINGLE_RECIPIENT) so it's easy to tell apart
// from a real "test all" in the log filters.
import { NextResponse } from "next/server";

import { canManageNotificationRecipients, getCurrentRole } from "@/lib/auth/role";
import { sendNotification } from "@/lib/notifications/service";

export const runtime = "nodejs";

const TEST_ALL_MESSAGE = "Test thông báo hệ thống Theo dõi hàng về";

export async function POST(request: Request) {
  if (!canManageNotificationRecipients(getCurrentRole())) {
    return NextResponse.json({ success: false, errorMessage: "Bạn không có quyền thực hiện thao tác này." }, { status: 403 });
  }

  let recipientId: string | undefined;
  try {
    const body = await request.json();
    recipientId = typeof body?.recipientId === "string" ? body.recipientId : undefined;
  } catch {
    // No body (or not JSON) — that's the normal "test all" case, not an error.
  }

  const result = await sendNotification({
    eventType: recipientId ? "TEST_SINGLE_RECIPIENT" : "TEST_ALL_RECIPIENTS",
    message: TEST_ALL_MESSAGE,
    recipientIds: recipientId ? [recipientId] : undefined,
    // No dedupeKey — a manual test send should always be allowed to repeat.
  });

  return NextResponse.json(result);
}
