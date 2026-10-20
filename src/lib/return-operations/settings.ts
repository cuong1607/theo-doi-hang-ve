// ============================================================
// PHASE SHOPEE-6B: configuration writes (delivery windows, default
// receivers, thresholds, notification settings + slots). Validation here —
// the server actions only authorize and call these. DB client injected.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { isReturnOperationType, type ReturnOperationType } from "./classify.ts";
import { normalizeSlot } from "./schedule.ts";
import { validateWindowSet, type WindowInput } from "./windows.ts";

export class ReturnSettingsError extends Error {}

const clean = (s: string | null | undefined) => (typeof s === "string" && s.trim() ? s.trim() : null);

/** Replaces the window set of ONE scope (shop / carrier, either may be null = any). */
export async function saveDeliveryWindowScope(db: SupabaseClient, input: { shopId: string | null; carrier: string | null; windows: Array<WindowInput & { id?: string | null }> }): Promise<void> {
  const carrier = clean(input.carrier);
  const errors = validateWindowSet(input.windows);
  if (input.windows.length === 0) errors.push("Cần ít nhất một ca (hoặc xoá cả nhóm cấu hình).");
  if (errors.length > 0) throw new ReturnSettingsError(errors.join(" "));

  let existingQ = db.from("return_delivery_windows").select("id");
  existingQ = input.shopId ? existingQ.eq("shop_id", input.shopId) : existingQ.is("shop_id", null);
  existingQ = carrier ? existingQ.ilike("carrier", carrier) : existingQ.is("carrier", null);
  const { data: existing, error } = await existingQ;
  if (error) throw new Error(error.message);
  const existingIds = new Set((existing ?? []).map((r) => r.id as string));
  const keep = new Set(input.windows.map((w) => w.id).filter((id): id is string => !!id && existingIds.has(id)));
  const remove = [...existingIds].filter((id) => !keep.has(id));
  if (remove.length > 0) {
    const { error: delErr } = await db.from("return_delivery_windows").delete().in("id", remove);
    if (delErr) throw new Error(delErr.message);
  }
  const rows = input.windows.map((w, i) => ({
    ...(w.id && keep.has(w.id) ? { id: w.id } : {}),
    shop_id: input.shopId,
    carrier,
    name: w.name.trim(),
    start_time: w.startTime,
    end_time: w.endTime,
    sort_order: i + 1,
    enabled: w.enabled,
  }));
  const updates = rows.filter((r) => "id" in r);
  const inserts = rows.filter((r) => !("id" in r));
  if (updates.length > 0) {
    const { error: upErr } = await db.from("return_delivery_windows").upsert(updates, { onConflict: "id" });
    if (upErr) throw new Error(upErr.message);
  }
  if (inserts.length > 0) {
    const { error: insErr } = await db.from("return_delivery_windows").insert(inserts);
    if (insErr) throw new Error(insErr.message);
  }
}

export async function deleteDeliveryWindowScope(db: SupabaseClient, input: { shopId: string | null; carrier: string | null }): Promise<void> {
  const carrier = clean(input.carrier);
  if (!input.shopId && !carrier) throw new ReturnSettingsError("Không xoá được cấu hình mặc định chung — hãy sửa các ca thay vì xoá.");
  let q = db.from("return_delivery_windows").delete();
  q = input.shopId ? q.eq("shop_id", input.shopId) : q.is("shop_id", null);
  q = carrier ? q.ilike("carrier", carrier) : q.is("carrier", null);
  const { error } = await q;
  if (error) throw new Error(error.message);
}

export async function saveDefaultReceiver(db: SupabaseClient, input: { shopId: string | null; operationType: ReturnOperationType; userId: string | null }): Promise<void> {
  if (!isReturnOperationType(input.operationType)) throw new ReturnSettingsError("Loại hoàn không hợp lệ.");
  let q = db.from("return_operation_assignments").select("id").eq("operation_type", input.operationType);
  q = input.shopId ? q.eq("shop_id", input.shopId) : q.is("shop_id", null);
  const { data, error } = await q.maybeSingle<{ id: string }>();
  if (error) throw new Error(error.message);
  const res = data
    ? await db.from("return_operation_assignments").update({ default_receiver_user_id: input.userId }).eq("id", data.id)
    : await db.from("return_operation_assignments").insert({ shop_id: input.shopId, operation_type: input.operationType, default_receiver_user_id: input.userId });
  if (res.error) throw new Error(res.error.message);
}

export interface OperationSettingsInput {
  confirmationEnabled: boolean;
  confirmAttentionHours: number;
  stuckTransitDays: number;
  trackingMissingHours: number;
  syncStaleWarnMinutes: number;
  trackingLookbackDays: number;
}

export async function saveOperationSettings(db: SupabaseClient, input: OperationSettingsInput, by: string | null): Promise<void> {
  const range = (v: number, min: number, max: number, label: string) => {
    if (!Number.isInteger(v) || v < min || v > max) throw new ReturnSettingsError(`${label} phải là số nguyên từ ${min} đến ${max}.`);
  };
  range(input.confirmAttentionHours, 1, 720, "Số giờ chờ xác nhận");
  range(input.stuckTransitDays, 1, 90, "Số ngày kẹt vận chuyển");
  range(input.trackingMissingHours, 1, 720, "Số giờ thiếu mã vận đơn");
  range(input.syncStaleWarnMinutes, 5, 1440, "Ngưỡng cảnh báo dữ liệu cũ");
  range(input.trackingLookbackDays, 1, 180, "Số ngày theo dõi vận chuyển");
  const { error } = await db
    .from("return_operation_settings")
    .update({
      confirmation_enabled: input.confirmationEnabled,
      confirm_attention_hours: input.confirmAttentionHours,
      stuck_transit_days: input.stuckTransitDays,
      tracking_missing_hours: input.trackingMissingHours,
      sync_stale_warn_minutes: input.syncStaleWarnMinutes,
      tracking_lookback_days: input.trackingLookbackDays,
      updated_at: new Date().toISOString(),
      updated_by: by,
    })
    .eq("id", true);
  if (error) throw new Error(error.message);
  const { error: attErr } = await db.rpc("refresh_return_operation_attention", { p_shop_id: null, p_operation_id: null });
  if (attErr) throw new Error(attErr.message);
}

export interface NotificationSettingInput {
  id?: string | null;
  shopId: string | null;
  name: string;
  enabled: boolean;
  carrierFilter: string | null;
  operationTypeFilter: ReturnOperationType | null;
  includeDelta: boolean;
  includeDetail: boolean;
  presyncMinutes: number;
  /** "HH:MM" slots. */
  slots: string[];
}

export function normalizeSlots(slots: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of slots) {
    if (!s.trim()) continue;
    const n = normalizeSlot(s);
    if (!n) throw new ReturnSettingsError(`Giờ gửi "${s}" không hợp lệ (HH:MM).`);
    out.add(n);
  }
  return [...out].sort();
}

export async function saveNotificationSetting(db: SupabaseClient, input: NotificationSettingInput): Promise<string> {
  const name = input.name.trim() || "Hàng hoàn đã giao";
  const slots = normalizeSlots(input.slots);
  if (input.enabled && slots.length === 0) throw new ReturnSettingsError("Bật thông báo cần ít nhất một giờ gửi.");
  if (slots.length > 12) throw new ReturnSettingsError("Tối đa 12 giờ gửi mỗi ngày.");
  if (!Number.isInteger(input.presyncMinutes) || input.presyncMinutes < 0 || input.presyncMinutes > 60) throw new ReturnSettingsError("Số phút đồng bộ trước phải từ 0 đến 60.");
  if (input.operationTypeFilter && !isReturnOperationType(input.operationTypeFilter)) throw new ReturnSettingsError("Loại hoàn không hợp lệ.");
  const row = {
    shop_id: input.shopId,
    name,
    enabled: input.enabled,
    carrier_filter: clean(input.carrierFilter),
    operation_type_filter: input.operationTypeFilter,
    include_delta: input.includeDelta,
    include_detail: input.includeDetail,
    presync_minutes: input.presyncMinutes,
  };
  let id = input.id ?? null;
  if (id) {
    const { error } = await db.from("return_notification_settings").update(row).eq("id", id);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await db.from("return_notification_settings").insert(row).select("id").single();
    if (error) throw new Error(error.message);
    id = data.id as string;
  }
  // slots: replace the set (runs reference the setting, not the slot rows)
  const { data: existing, error: exErr } = await db.from("return_notification_schedules").select("id, time_of_day").eq("setting_id", id);
  if (exErr) throw new Error(exErr.message);
  const have = new Map((existing ?? []).map((r) => [String(r.time_of_day).slice(0, 5), r.id as string]));
  const remove = [...have.entries()].filter(([t]) => !slots.includes(t)).map(([, rid]) => rid);
  if (remove.length > 0) {
    const { error } = await db.from("return_notification_schedules").delete().in("id", remove);
    if (error) throw new Error(error.message);
  }
  const add = slots.filter((t) => !have.has(t)).map((t) => ({ setting_id: id, time_of_day: t, enabled: true, sort_order: slots.indexOf(t) }));
  if (add.length > 0) {
    const { error } = await db.from("return_notification_schedules").insert(add);
    if (error) throw new Error(error.message);
  }
  return id!;
}

export async function deleteNotificationSetting(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("return_notification_settings").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
