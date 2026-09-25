// PHẦN 8 — POST /api/notifications/test-all: admin-only, sends a fixed test
// message to every active notification_recipients row via the shared
// sendNotification() service (never calls sendZaloTextMessage directly from
// here, per the phase spec).
import { NextResponse } from "next/server";

import { canManageNotificationRecipients, getCurrentRole } from "@/lib/auth/role";
import { sendNotification } from "@/lib/notifications/service";

export const runtime = "nodejs";

const TEST_ALL_MESSAGE = "Test thông báo hệ thống Theo dõi hàng về";

export async function POST() {
  if (!canManageNotificationRecipients(getCurrentRole())) {
    return NextResponse.json({ success: false, errorMessage: "Bạn không có quyền thực hiện thao tác này." }, { status: 403 });
  }

  const result = await sendNotification({
    eventType: "TEST_ALL_RECIPIENTS",
    message: TEST_ALL_MESSAGE,
    // No dedupeKey — a manual test send should always be allowed to repeat.
  });

  return NextResponse.json(result);
}
