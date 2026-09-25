// PHASE ZL4: evaluateOutstandingNotifications() — the single place that
// decides whether a v_outstanding status change is worth alerting about,
// tracks per-SKU state so it never re-alerts on an unchanged status, and
// fans the result out via ZL2's sendNotification() (never calls Zalo
// directly). No DB trigger calls this — callers are the receipt/invoice
// server actions, after their own write succeeds (see receipts/actions.ts,
// invoices/actions.ts).
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "./service";
import { formatOutstandingAlertMessage, type OutstandingAlertItem } from "./outstanding-alert-message";
import { toTrackedState, shouldAlert, type TrackedState } from "./outstanding-alert-state";

const EVENT_TYPE = "LOW_STOCK_ALERT";
const ENTITY_TYPE = "invoice_item";

export type EvaluateOutstandingNotificationsInput = {
  supplierIds: string[];
  productIds: string[];
};

export type EvaluateOutstandingNotificationsResult = {
  evaluatedCount: number;
  transitionCount: number;
  alertBatches: {
    supplierId: string;
    supplierName: string;
    itemCount: number;
    sentCount: number;
    failedCount: number;
    skippedCount: number;
  }[];
};

type OutstandingRow = {
  invoice_item_id: string;
  supplier_id: string;
  supplier_name: string;
  sku: string;
  product_name: string;
  invoice_no: string;
  invoice_qty: number;
  received_qty: number;
  remaining_qty: number;
  status: "need_makeup" | "low" | "normal";
};

export async function evaluateOutstandingNotifications(
  input: EvaluateOutstandingNotificationsInput
): Promise<EvaluateOutstandingNotificationsResult> {
  const supplierIds = [...new Set(input.supplierIds)].filter(Boolean);
  const productIds = [...new Set(input.productIds)].filter(Boolean);

  const empty: EvaluateOutstandingNotificationsResult = { evaluatedCount: 0, transitionCount: 0, alertBatches: [] };
  if (supplierIds.length === 0 || productIds.length === 0) return empty;

  const supabase = createAdminClient();

  const { data: outstandingRows, error: outstandingError } = await supabase
    .from("v_outstanding")
    .select(
      "invoice_item_id, supplier_id, supplier_name, sku, product_name, invoice_no, invoice_qty, received_qty, remaining_qty, status"
    )
    .in("supplier_id", supplierIds)
    .in("product_id", productIds);

  if (outstandingError) {
    throw new Error(`Không thể đọc trạng thái hàng còn phải về: ${outstandingError.message}`);
  }

  const rows = (outstandingRows ?? []) as OutstandingRow[];
  if (rows.length === 0) return empty;

  const { data: stateRows, error: stateError } = await supabase
    .from("notification_event_states")
    .select("entity_id, current_state")
    .eq("event_type", EVENT_TYPE)
    .eq("entity_type", ENTITY_TYPE)
    .in(
      "entity_id",
      rows.map((r) => r.invoice_item_id)
    );

  if (stateError) {
    throw new Error(`Không thể đọc trạng thái cảnh báo trước đó: ${stateError.message}`);
  }

  const oldStateByEntity = new Map<string, TrackedState>(
    (stateRows ?? []).map((r) => [r.entity_id, r.current_state as TrackedState])
  );

  // One shared timestamp for this whole evaluate() call — used both as the
  // new state rows' updated_at and as the dedupe key's "version" token
  // (Phần DEDUPE: "dùng event state updated timestamp/version" so a later
  // drop-then-rise-then-drop-again can alert again, since each real
  // transition gets a fresh version). This is a defensive backstop only —
  // the primary anti-spam mechanism is the state-transition check itself: a
  // duplicate evaluate() call for the same underlying change finds
  // oldState === newState (already persisted by the first call) and never
  // reaches the alert step at all.
  const nowIso = new Date().toISOString();

  const upsertRows: { event_type: string; entity_type: string; entity_id: string; current_state: TrackedState; updated_at: string }[] = [];
  const alertCandidatesBySupplier = new Map<string, { supplierName: string; items: OutstandingAlertItem[] }>();

  for (const row of rows) {
    const newState = toTrackedState(row.status);
    const oldState = oldStateByEntity.get(row.invoice_item_id) ?? "normal";

    if (newState === oldState) continue; // not a transition — no update, no alert

    upsertRows.push({
      event_type: EVENT_TYPE,
      entity_type: ENTITY_TYPE,
      entity_id: row.invoice_item_id,
      current_state: newState,
      updated_at: nowIso,
    });

    if (newState !== "normal" && shouldAlert(oldState, newState)) {
      const bucket = alertCandidatesBySupplier.get(row.supplier_id) ?? { supplierName: row.supplier_name, items: [] };
      bucket.items.push({
        invoiceItemId: row.invoice_item_id,
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        sku: row.sku,
        productName: row.product_name,
        invoiceNo: row.invoice_no,
        invoiceQty: row.invoice_qty,
        receivedQty: row.received_qty,
        remainingQty: row.remaining_qty,
        alertState: newState,
      });
      alertCandidatesBySupplier.set(row.supplier_id, bucket);
    }
  }

  if (upsertRows.length > 0) {
    const { error: upsertError } = await supabase
      .from("notification_event_states")
      .upsert(upsertRows, { onConflict: "event_type,entity_type,entity_id" });
    if (upsertError) {
      throw new Error(`Không thể lưu trạng thái cảnh báo mới: ${upsertError.message}`);
    }
  }

  const alertBatches: EvaluateOutstandingNotificationsResult["alertBatches"] = [];

  for (const [supplierId, bucket] of alertCandidatesBySupplier) {
    const message = formatOutstandingAlertMessage(bucket.supplierName, bucket.items);
    const dedupeKey = `${EVENT_TYPE}:${supplierId}:${nowIso}`;

    const result = await sendNotification({
      eventType: EVENT_TYPE,
      message,
      entityType: "supplier",
      entityId: supplierId,
      dedupeKey,
    });

    alertBatches.push({
      supplierId,
      supplierName: bucket.supplierName,
      itemCount: bucket.items.length,
      sentCount: result.sentCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    });
  }

  return { evaluatedCount: rows.length, transitionCount: upsertRows.length, alertBatches };
}

// Called from receipts/invoices server actions right after their own write
// succeeds. Never throws — a notification-pipeline failure (bad RPC, Zalo
// down, etc.) must never roll back or error out an already-successful
// receipt/invoice save. Callers that want the actual result (e.g. for a
// future admin test action) should call evaluateOutstandingNotifications()
// directly instead.
export async function triggerOutstandingAlertCheck(input: EvaluateOutstandingNotificationsInput): Promise<void> {
  try {
    await evaluateOutstandingNotifications(input);
  } catch (err) {
    console.error("[ZL4] evaluateOutstandingNotifications failed:", err);
  }
}
