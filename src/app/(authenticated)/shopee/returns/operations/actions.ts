"use server";

// SHOPEE-6B daily return-operation actions.
//   refreshReturnDataAction   channel:sync — ONLY enqueues return / return_logistics /
//                             failed_delivery jobs (manual, focused on the date) and
//                             kicks the worker after the response; the page polls.
//   confirmReceivedAction     return:receive — "Đã nhận" (operational only)
//   settings actions          channel:manage
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { after } from "next/server";
import { z } from "zod";

import { authorizeAction } from "@/lib/auth/session";
import { SyncJobError } from "@/lib/channels/core/sync-jobs";
import { kickShopeeSyncWorker } from "@/lib/channels/shopee/server";
import { requestShopeeSync } from "@/lib/channels/shopee/sync-service";
import { loadNotificationSettings, previewNotificationMessage } from "@/lib/return-operations/notifications";
import { PRESYNC_SYNC_TYPES } from "@/lib/return-operations/notifications";
import {
  deleteDeliveryWindowScope,
  deleteNotificationSetting,
  ReturnSettingsError,
  saveDefaultReceiver,
  saveDeliveryWindowScope,
  saveNotificationSetting,
  saveOperationSettings,
  type NotificationSettingInput,
  type OperationSettingsInput,
} from "@/lib/return-operations/settings";
import type { WindowInput } from "@/lib/return-operations/windows";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: boolean; message: string; warning?: boolean };

const uuid = z.string().uuid();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PATH = "/shopee/returns/operations";

async function requestOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")}://${host}`;
}

function fail(err: unknown, fallback: string): ActionResult {
  if (err instanceof ReturnSettingsError || err instanceof SyncJobError) return { ok: false, message: err.message };
  console.error(JSON.stringify({ source: "return-operations-action", message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
  return { ok: false, message: fallback };
}

export async function refreshReturnDataAction(shopId: string | null, date: string): Promise<ActionResult> {
  const authz = await authorizeAction("channel:sync");
  if (!authz.ok) return { ok: false, message: authz.message };
  if ((shopId !== null && !uuid.safeParse(shopId).success) || !DATE.test(date)) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const db = createAdminClient();
  try {
    let shopIds: string[];
    if (shopId) shopIds = [shopId];
    else {
      const { data, error } = await db.from("shops").select("id").eq("channel", "shopee").eq("is_active", true);
      if (error) throw new Error(error.message);
      shopIds = (data ?? []).map((s) => s.id as string);
    }
    if (shopIds.length === 0) return { ok: false, message: "Chưa có shop Shopee nào." };
    let created = 0;
    let existing = 0;
    for (const id of shopIds) {
      for (const syncType of PRESYNC_SYNC_TYPES) {
        const job = await requestShopeeSync(db, { shopId: id, syncType, mode: "manual", focusDate: date, createdBy: authz.auth.user.id });
        if (job.created) created++;
        else existing++;
      }
    }
    const origin = await requestOrigin();
    after(() => kickShopeeSyncWorker({ origin }).then(() => undefined));
    revalidatePath(PATH);
    return created > 0
      ? { ok: true, message: "Đã gửi yêu cầu làm mới dữ liệu hoàn — số liệu sẽ tự cập nhật khi đồng bộ xong." }
      : { ok: true, message: existing > 0 ? "Đang có yêu cầu làm mới chạy — đã ưu tiên chạy trước." : "Không có gì để làm mới." };
  } catch (err) {
    return fail(err, "Không tạo được yêu cầu làm mới.");
  }
}

export async function confirmReceivedAction(operationId: string, confirm: boolean): Promise<ActionResult> {
  const authz = await authorizeAction("return:receive");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(operationId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  const { error } = await createAdminClient().rpc("confirm_return_operation_received", { p_operation_id: operationId, p_by: authz.auth.user.id, p_confirm: confirm });
  if (error) return fail(new Error(error.message), "Không lưu được xác nhận.");
  revalidatePath(PATH);
  return { ok: true, message: confirm ? "Đã xác nhận nhận hàng (không ảnh hưởng tồn kho / giá vốn)." : "Đã bỏ xác nhận." };
}

// ----------------------------------------------------------------- settings

const windowSchema = z.object({ id: z.string().uuid().nullish(), name: z.string().max(60), startTime: z.string(), endTime: z.string(), enabled: z.boolean() });

export async function saveWindowScopeAction(input: { shopId: string | null; carrier: string | null; windows: Array<WindowInput & { id?: string | null }> }): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  const parsed = z.object({ shopId: uuid.nullable(), carrier: z.string().max(80).nullable(), windows: z.array(windowSchema).max(12) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    await saveDeliveryWindowScope(createAdminClient(), parsed.data);
    revalidatePath(PATH, "layout");
    return { ok: true, message: "Đã lưu cấu hình ca giao." };
  } catch (err) {
    return fail(err, "Không lưu được cấu hình ca giao.");
  }
}

export async function deleteWindowScopeAction(input: { shopId: string | null; carrier: string | null }): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (input.shopId !== null && !uuid.safeParse(input.shopId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    await deleteDeliveryWindowScope(createAdminClient(), input);
    revalidatePath(PATH, "layout");
    return { ok: true, message: "Đã xoá nhóm ca giao." };
  } catch (err) {
    return fail(err, "Không xoá được nhóm ca giao.");
  }
}

export async function saveDefaultReceiverAction(input: { operationType: "customer_return" | "failed_delivery_return"; userId: string | null }): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (input.userId !== null && !uuid.safeParse(input.userId).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    await saveDefaultReceiver(createAdminClient(), { shopId: null, operationType: input.operationType, userId: input.userId });
    revalidatePath(PATH, "layout");
    return { ok: true, message: "Đã lưu người phụ trách mặc định (áp dụng cho đơn hoàn mới)." };
  } catch (err) {
    return fail(err, "Không lưu được người phụ trách.");
  }
}

export async function saveOperationSettingsAction(input: OperationSettingsInput): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  try {
    await saveOperationSettings(createAdminClient(), input, authz.auth.user.id);
    revalidatePath(PATH, "layout");
    return { ok: true, message: "Đã lưu ngưỡng cảnh báo." };
  } catch (err) {
    return fail(err, "Không lưu được ngưỡng cảnh báo.");
  }
}

export async function saveNotificationSettingAction(input: NotificationSettingInput): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if ((input.id && !uuid.safeParse(input.id).success) || (input.shopId !== null && !uuid.safeParse(input.shopId).success)) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    await saveNotificationSetting(createAdminClient(), input);
    revalidatePath(PATH, "layout");
    return { ok: true, message: input.enabled ? "Đã lưu — thông báo sẽ tự gửi theo giờ đã đặt." : "Đã lưu (thông báo đang tắt)." };
  } catch (err) {
    return fail(err, "Không lưu được cấu hình thông báo.");
  }
}

export async function deleteNotificationSettingAction(id: string): Promise<ActionResult> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(id).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    await deleteNotificationSetting(createAdminClient(), id);
    revalidatePath(PATH, "layout");
    return { ok: true, message: "Đã xoá cấu hình thông báo (lịch sử gửi vẫn giữ)." };
  } catch (err) {
    return fail(err, "Không xoá được cấu hình thông báo.");
  }
}

export async function previewNotificationAction(id: string): Promise<ActionResult & { preview?: string }> {
  const authz = await authorizeAction("channel:manage");
  if (!authz.ok) return { ok: false, message: authz.message };
  if (!uuid.safeParse(id).success) return { ok: false, message: "Dữ liệu không hợp lệ." };
  try {
    const db = createAdminClient();
    const setting = (await loadNotificationSettings(db)).find((s) => s.id === id);
    if (!setting) return { ok: false, message: "Không tìm thấy cấu hình." };
    return { ok: true, message: "Xem trước (chưa gửi).", preview: await previewNotificationMessage(db, setting) };
  } catch (err) {
    return fail(err, "Không tạo được bản xem trước.");
  }
}
