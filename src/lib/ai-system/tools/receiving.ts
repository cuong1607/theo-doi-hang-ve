// ============================================================
// PHASE 05 — "Theo dõi hàng về" tools (read only).
//
// What the system ACTUALLY records (migrations 00001 / 00027 / 00034):
//   receipts + receipt_items   goods physically received, per day / supplier /
//                              shift (phiếu nhận hàng, entered by staff)
//   v_outstanding              per invoice line: invoiced qty − received qty
//                              ("Hàng còn phải về"), status computed in SQL
// What it does NOT record: an expected arrival date, a shipment / lot in
// transit, a carrier status. So "lô nào sắp về / đang chậm" can't be answered
// from data and no tool pretends to (docs/zalo-ai/phase-05-system-assistant.md).
// Every figure below is read from the SAME RPC / view as the screens.
// ============================================================
import { z } from "zod";

import { STATUS_LABELS } from "../../outstanding/status.ts";
import type { SystemToolDefinition, ToolContext } from "../types.ts";
import { dmy, done, escapeIlike, fail, findSupplier, lookupFailure, nameArg, periodArg, qty, resolvePeriodArg, ToolReadError, vnd, type SupplierRef } from "./common.ts";

type OutstandingStatus = keyof typeof STATUS_LABELS;

const NO_EXPECTED_DATE = "Hệ thống không lưu ngày dự kiến về hay trạng thái vận chuyển, nên không xác định được lô nào sắp về hoặc đang chậm; chỉ biết hàng đã nhận (phiếu nhận hàng) và hàng còn thiếu so với hóa đơn.";

async function lastReceiptAt(ctx: ToolContext, supplierId: string | null): Promise<string | null> {
  let q = ctx.db.from("receipts").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  if (supplierId) q = q.eq("supplier_id", supplierId);
  const { data, error } = await q.maybeSingle<{ updated_at: string }>();
  if (error) throw new ToolReadError("phiếu nhận hàng", error.message);
  return data?.updated_at ?? null;
}

async function resolveSupplier(ctx: ToolContext, phrase: string | undefined): Promise<{ ok: true; supplier: SupplierRef | null } | { ok: false; result: ReturnType<typeof lookupFailure> }> {
  if (!phrase) return { ok: true, supplier: null };
  const found = await findSupplier(ctx.db, phrase);
  if (found.kind === "one") return { ok: true, supplier: found.value };
  return { ok: false, result: lookupFailure(found.kind, "nhà cung cấp", phrase, found.kind === "many" ? found.values : []) };
}

// ------------------------------------------------------------------ get_receiving_status

const receivingArgs = z
  .object({
    period: periodArg.optional().describe("Mặc định: hôm nay"),
    supplier: nameArg("Tên hoặc mã nhà cung cấp (tùy chọn)").optional(),
    sku: nameArg("Mã SKU sản phẩm (tùy chọn)").optional(),
  })
  .strict();

interface DailyGroupRow {
  receipt_date: string;
  supplier_name: string;
  supplier_code: string;
  sku_count: number;
  total_delivered_qty: number;
  total_received_qty: number;
  total_difference_qty: number;
  total_line_total: number;
  linked_invoice_no: string | null;
  total_groups: number;
}

export const getReceivingStatus: SystemToolDefinition<z.infer<typeof receivingArgs>> = {
  name: "get_receiving_status",
  title: "Hàng đã về (phiếu nhận hàng)",
  description:
    "Hàng ĐÃ NHẬN theo ngày và nhà cung cấp (phiếu nhận hàng): số mã, số lượng giao / nhận / chênh lệch, giá trị theo đơn giá phiếu, đã lập hóa đơn chưa. Dùng cho: hôm nay / tuần này hàng về những gì, NCC X đã giao gì. KHÔNG có dữ liệu hàng sắp về hay lô đang chậm.",
  module: "receiving",
  sensitivity: "operational",
  requiredPermissions: ["receipt:view"],
  input: receivingArgs,
  timeoutMs: 8_000,
  maxRows: 20,
  freshness: "Nhập tay theo phiếu; cập nhật ngay khi nhân viên lưu phiếu.",
  examples: ["Hôm nay hàng về những gì?", "Tuần này NCC An Phát giao bao nhiêu?"],
  async run(args, ctx) {
    const period = resolvePeriodArg(args.period, "today", ctx.now);
    if ("error" in period) return fail("invalid_args", period.error);
    const sup = await resolveSupplier(ctx, args.supplier);
    if (!sup.ok) return sup.result;
    const limit = Math.min(ctx.maxRows, this.maxRows);
    const { data, error } = await ctx.db.rpc("get_receipt_daily_groups", {
      p_from_date: period.fromDate,
      p_to_date: period.toDate,
      p_supplier_id: sup.supplier?.id ?? null,
      p_sku: args.sku ? escapeIlike(args.sku) : null,
      p_product_name: null,
      p_limit: limit,
      p_offset: 0,
    });
    if (error) throw new ToolReadError("get_receipt_daily_groups", error.message);
    const rows = (data ?? []) as DailyGroupRow[];
    const total = rows[0]?.total_groups ?? 0;
    const updatedAt = await lastReceiptAt(ctx, sup.supplier?.id ?? null);
    const scope = { from: period.fromDate, to: period.toDate, supplier_id: sup.supplier?.id ?? null, sku_filter: !!args.sku };
    const filterText = [sup.supplier ? `NCC ${sup.supplier.name}` : null, args.sku ? `SKU chứa “${args.sku}”` : null].filter(Boolean).join(", ");
    const coverage = `${period.label}${filterText ? ` · ${filterText}` : ""}`;
    const source = { label: "Lịch sử hàng về", origin: "RPC get_receipt_daily_groups (phiếu nhận hàng)", href: "/receipts", readAt: ctx.now.toISOString(), dataUpdatedAt: updatedAt, freshness: "manual_entry" as const, coverage };
    const caveats = [NO_EXPECTED_DATE];
    if (args.sku) caveats.push("Đang lọc theo SKU: số lượng / giá trị chỉ tính các mã khớp, không phải tổng cả ngày.");
    if (!rows.length) {
      return done({ data: { period: { from: period.fromDate, to: period.toDate, label: period.label }, filter: filterText || null, total_groups: 0, groups: [] }, lines: [`Không có phiếu nhận hàng nào trong ${coverage}.`], source, rowCount: 0, caveats, scope, empty: true });
    }
    const groups = rows.map((r) => ({
      date: dmy(r.receipt_date),
      supplier: `${r.supplier_name} (${r.supplier_code})`,
      sku_count: r.sku_count,
      delivered_qty: qty(r.total_delivered_qty),
      received_qty: qty(r.total_received_qty),
      difference_qty: qty(r.total_difference_qty),
      received_value: vnd(r.total_line_total),
      invoice: r.linked_invoice_no ?? null,
    }));
    const lines = [
      `Hàng đã nhận ${coverage}: ${total} lượt (ngày × NCC)${total > rows.length ? `, hiển thị ${rows.length} lượt mới nhất` : ""}.`,
      ...groups.map((g) => `• ${g.date} · ${g.supplier}: ${g.sku_count} mã, giao ${g.delivered_qty}, nhận ${g.received_qty} (chênh ${g.difference_qty}), giá trị ${g.received_value}, ${g.invoice ? `HĐ ${g.invoice}` : "chưa lập HĐ"}.`),
    ];
    return done({ data: { period: { from: period.fromDate, to: period.toDate, label: period.label }, filter: filterText || null, total_groups: total, shown: rows.length, groups }, lines, source, rowCount: rows.length, caveats, scope });
  },
};

// ------------------------------------------------------------------ get_outstanding_goods

const outstandingArgs = z
  .object({
    supplier: nameArg("Tên hoặc mã nhà cung cấp (tùy chọn)").optional(),
    sku: nameArg("Mã SKU (tùy chọn)").optional(),
    invoiceNo: nameArg("Số hóa đơn cần xem trạng thái nhận hàng (tùy chọn)").optional(),
    view: z.enum(["remaining", "over_received"]).default("remaining").describe("remaining = còn thiếu chưa về (mặc định); over_received = nhận dư, cần xuất bù"),
  })
  .strict();

interface OutstandingRow {
  invoice_no: string;
  invoice_date: string;
  supplier_id: string;
  supplier_name: string;
  supplier_code: string;
  sku: string;
  product_name: string;
  unit: string;
  invoice_qty: number;
  received_qty: number;
  remaining_qty: number;
  remaining_value: number;
  status: OutstandingStatus;
}

const COLS = "invoice_no, invoice_date, supplier_id, supplier_name, supplier_code, sku, product_name, unit, invoice_qty, received_qty, remaining_qty, remaining_value, status";

export const getOutstandingGoods: SystemToolDefinition<z.infer<typeof outstandingArgs>> = {
  name: "get_outstanding_goods",
  title: "Hàng còn phải về",
  description:
    "Hàng đã có trên hóa đơn nhưng CHƯA NHẬN ĐỦ (số lượng hóa đơn − đã nhận), theo dòng hóa đơn; tổng theo nhà cung cấp. Dùng cho: NCC nào còn hàng chưa giao, hóa đơn ABC đã nhận đủ chưa, SKU X còn thiếu bao nhiêu. view=over_received cho các dòng nhận dư (cần xuất bù).",
  module: "receiving",
  sensitivity: "operational",
  requiredPermissions: ["outstanding:view"],
  input: outstandingArgs,
  timeoutMs: 8_000,
  maxRows: 20,
  freshness: "Tính trực tiếp từ hóa đơn và phiếu nhận hàng hiện có (view v_outstanding).",
  examples: ["Nhà cung cấp nào còn hàng chưa giao?", "Hóa đơn HD001 đã nhận đủ chưa?"],
  async run(args, ctx) {
    const sup = await resolveSupplier(ctx, args.supplier);
    if (!sup.ok) return sup.result;
    const supplierId = sup.supplier?.id ?? null;
    const limit = Math.min(ctx.maxRows, this.maxRows);
    const byInvoice = !!args.invoiceNo;
    const statuses: OutstandingStatus[] = byInvoice ? ["need_makeup", "complete", "low", "normal"] : args.view === "over_received" ? ["need_makeup"] : ["low", "normal"];
    const base = () => {
      let q = ctx.db.from("v_outstanding").select(COLS, { count: "exact" }).in("status", statuses);
      if (supplierId) q = q.eq("supplier_id", supplierId);
      if (args.sku) q = q.ilike("sku", `%${escapeIlike(args.sku)}%`);
      if (args.invoiceNo) q = q.ilike("invoice_no", escapeIlike(args.invoiceNo));
      return q;
    };
    const { data, error, count } = await base().order("invoice_date", { ascending: true }).order("invoice_no").order("sku").range(0, limit - 1);
    if (error) throw new ToolReadError("v_outstanding", error.message);
    const rows = (data ?? []) as OutstandingRow[];
    const total = count ?? rows.length;
    const scope = { supplier_id: supplierId, sku_filter: !!args.sku, invoice_filter: byInvoice, view: byInvoice ? "invoice" : args.view };
    const filterText = [sup.supplier ? `NCC ${sup.supplier.name}` : null, args.sku ? `SKU chứa “${args.sku}”` : null, byInvoice ? `hóa đơn ${args.invoiceNo}` : null].filter(Boolean).join(", ");
    const what = byInvoice ? "Trạng thái nhận hàng theo hóa đơn" : args.view === "over_received" ? "Dòng nhận dư (cần xuất bù)" : "Hàng còn phải về";
    const coverage = `${what}${filterText ? ` · ${filterText}` : ""} · tại thời điểm hỏi`;
    const source = { label: "Hàng còn phải về", origin: "view v_outstanding", href: "/outstanding", readAt: ctx.now.toISOString(), dataUpdatedAt: await lastReceiptAt(ctx, supplierId), freshness: "manual_entry" as const, coverage };
    const caveats = [NO_EXPECTED_DATE, "Số liệu giống màn hình Hàng còn phải về; nếu cùng NCC + SKU có nhiều hóa đơn chồng nhau, số đã nhận có thể được tính cho cả các hóa đơn đó (xem ghi chú của view v_outstanding)."];
    if (byInvoice && !rows.length) return fail("not_found", `Không tìm thấy hóa đơn “${args.invoiceNo}”${sup.supplier ? ` của NCC ${sup.supplier.name}` : ""}.`, scope);
    if (!rows.length) {
      return done({ data: { view: scope.view, filter: filterText || null, total_lines: 0, lines: [] }, lines: [`Không có dòng nào: ${coverage}.`], source, rowCount: 0, caveats, scope, empty: true });
    }

    // per-supplier totals over the WHOLE filtered set (≤ 1000 rows; beyond that it says so)
    let bySupplier: Array<{ supplier: string; lines: number; invoices: number; remaining_value: string }> = [];
    let groupedTruncated = false;
    if (!byInvoice && !supplierId) {
      const all = await base().order("supplier_name").order("invoice_date").range(0, 999);
      if (all.error) throw new ToolReadError("v_outstanding", all.error.message);
      const agg = new Map<string, { name: string; lines: number; invoices: Set<string>; value: number }>();
      for (const r of (all.data ?? []) as OutstandingRow[]) {
        const a = agg.get(r.supplier_id) ?? { name: `${r.supplier_name} (${r.supplier_code})`, lines: 0, invoices: new Set<string>(), value: 0 };
        a.lines++;
        a.invoices.add(r.invoice_no);
        a.value += Number(r.remaining_value) || 0;
        agg.set(r.supplier_id, a);
      }
      groupedTruncated = (all.count ?? 0) > 1000;
      bySupplier = [...agg.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 10).map((a) => ({ supplier: a.name, lines: a.lines, invoices: a.invoices.size, remaining_value: vnd(a.value) }));
    }

    const items = rows.map((r) => ({
      invoice: r.invoice_no,
      invoice_date: dmy(r.invoice_date),
      supplier: `${r.supplier_name} (${r.supplier_code})`,
      sku: r.sku,
      product: r.product_name.slice(0, 80),
      invoice_qty: qty(r.invoice_qty),
      received_qty: qty(r.received_qty),
      remaining_qty: qty(r.remaining_qty),
      unit: r.unit,
      remaining_value: vnd(r.remaining_value),
      status: STATUS_LABELS[r.status] ?? r.status,
    }));
    const lines = [
      `${coverage}: ${total} dòng${total > rows.length ? ` (hiển thị ${rows.length} dòng cũ nhất)` : ""}.`,
      ...(bySupplier.length ? ["Theo nhà cung cấp:", ...bySupplier.map((s) => `• ${s.supplier}: ${s.lines} dòng / ${s.invoices} hóa đơn, giá trị còn lại ${s.remaining_value}.`)] : []),
      ...(bySupplier.length ? ["Chi tiết:"] : []),
      ...items.map((i) => `• HĐ ${i.invoice} (${i.invoice_date}) · ${i.supplier} · ${i.sku} ${i.product}: HĐ ${i.invoice_qty}, đã nhận ${i.received_qty}, còn ${i.remaining_qty} ${i.unit} (${i.remaining_value}) — ${i.status}.`),
    ];
    if (groupedTruncated) caveats.push("Có hơn 1000 dòng: bảng theo NCC chỉ tính 1000 dòng đầu.");
    return done({ data: { view: scope.view, filter: filterText || null, total_lines: total, shown: rows.length, by_supplier: bySupplier, lines: items }, lines, source, rowCount: rows.length, caveats, scope });
  },
};

export const RECEIVING_TOOLS = [getReceivingStatus, getOutstandingGoods] as const;
