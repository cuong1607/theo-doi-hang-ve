"use server";

import { revalidatePath } from "next/cache";

import { canManageNotificationRecipients, getCurrentRole } from "@/lib/auth/role";
import { retryFailedNotification } from "@/lib/notifications/service";

export type RetryLogActionState = { status: "idle" | "error" | "success"; message?: string };

// Phần 1 (ZL7) — "Retry" button on a failed log row. Thin wrapper around
// retryFailedNotification (already built in ZL2's service.ts, just never
// had a UI button before) — no new send/retry logic here.
export async function retryNotificationLog(logId: string): Promise<RetryLogActionState> {
  if (!canManageNotificationRecipients(getCurrentRole())) {
    return { status: "error", message: "Bạn không có quyền thực hiện thao tác này." };
  }

  const result = await retryFailedNotification(logId);
  revalidatePath("/settings/notifications");

  if (result.status === "sent") {
    return { status: "success", message: "Đã gửi lại thành công." };
  }
  if (result.status === "not_found") {
    return { status: "error", message: "Không tìm thấy log thông báo." };
  }
  if (result.status === "not_retryable") {
    return { status: "error", message: "Chỉ có thể gửi lại thông báo đang ở trạng thái thất bại." };
  }
  return { status: "error", message: result.errorMessage ?? "Gửi lại thất bại." };
}
