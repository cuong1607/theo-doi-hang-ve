// ============================================================
// PHASE 05 — Hóa đơn & công nợ NCC tools (read only, financial).
//
// Every amount comes from the SAME SQL the screens use — nothing is
// recalculated here:
//   v_supplier_debt_summary  per-supplier totals (00017)        → /debts
//   v_invoice_debt           per-invoice final / paid / remaining (00017/00025)
//   get_debt_overview        totals over a filtered set (00025)  → /debts
//   v_payment_summary        payments + linked invoices (00020)   → /payments
// Not in the data: a due date / payment term. "Quá hạn" therefore can't be
// computed; get_invoices exposes the invoice AGE (days since invoice date),
// labelled as such, never as "overdue".
// ============================================================
import { z } from "zod";

import { PAYMENT_STATUS_LABELS } from "../../debt/status.ts";
import type { SystemToolDefinition, ToolContext } from "../types.ts";
import { daysSince, dmy, done, escapeIlike, fail, findSupplier, lookupFailure, nameArg, periodArg, resolvePeriodArg, ToolReadError, vnd, vnToday, type SupplierRef } from "./common.ts";

const ALL_TIME_FROM = "2000-01-01";
const NO_DUE_DATE = "Hệ thống không lưu hạn thanh toán, nên không xác định được công nợ quá hạn; “tuổi” là số ngày tính từ ngày hóa đơn.";

async function payablesUpdatedAt(ctx: ToolContext): Promise<string | null> {
  const [inv, pay] = await Promise.all([
    ctx.db.from("invoices").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle<{ updated_at: string }>(),
    ctx.db.from("payments").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle<{ updated_at: string }>(),
  ]);
  if (inv.error) throw new ToolReadError("hóa đơn", inv.error.message);
  if (pay.error) throw new ToolReadError("thanh toán", pay.error.message);
  return [inv.data?.updated_at, pay.data?.updated_at].filter((v): v is string => !!v).sort().at(-1) ?? null;
}

async function supplierOf(ctx: ToolContext, phrase: string | undefined) {
  if (!phrase) return { ok: true as const, supplier: null as SupplierRef | null };
  const found = await findSupplier(ctx.db, phrase);
  if (found.kind === "one") return { ok: true as const, supplier: found.value };
  return { ok: false as const, result: lookupFailure(found.kind, "nhà cung cấp", phrase, found.kind === "many" ? found.values : []) };
}

interface DebtOverview {
  total_final_amount: number;
  total_paid_amount: number;
  total_remaining_amount: number;
  open_invoice_count: number;
}

async function debtOverview(ctx: ToolContext, f: { from: string; to: string; supplierId: string | null; status: string | null; search: string | null }): Promise<DebtOverview> {
  const { data, error } = await ctx.db.rpc("get_debt_overview", { p_from_date: f.from, p_to_date: f.to, p_supplier_id: f.supplierId, p_status: f.status, p_search: f.search }).maybeSingle<DebtOverview>();
  if (error) throw new ToolReadError("get_debt_overview", error.message);
  return data ?? { total_final_amount: 0, total_paid_amount: 0, total_remaining_amount: 0, open_invoice_count: 0 };
}

// ------------------------------------------------------------------ get_supplier_payables

const payablesArgs = z
  .object({
    supplier: nameArg("Tên hoặc mã nhà cung cấp (tùy chọn)").optional(),
    includeSettled: z.boolean().default(false).describe("true = liệt kê cả NCC đã trả hết"),
  })
  .strict();

interface SupplierDebtRow {
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  supplier_final_total: number;
  supplier_paid_total: number;
  supplier_remaining_total: number;
  supplier_open_invoice_count: number;
}

export const getSupplierPayables: SystemToolDefinition<z.infer<typeof payablesArgs>> = {
  name: "get_supplier_payables",
  title: "Công nợ nhà cung cấp",
  description:
    "Công nợ phải trả nhà cung cấp HIỆN TẠI (toàn bộ hóa đơn đến nay): tổng phải trả, đã trả, còn nợ, số hóa đơn chưa trả xong; danh sách NCC còn nợ nhiều nhất. Dùng cho: còn nợ NCC bao nhiêu, nợ ai nhiều nhất, NCC X còn nợ bao nhiêu.",
  module: "payables",
  sensitivity: "financial",
  requiredPermissions: ["debt:view"],
  input: payablesArgs,
  timeoutMs: 8_000,
  maxRows: 20,
  freshness: "Tính trực tiếp từ hóa đơn và phiếu thanh toán đã nhập (view v_supplier_debt_summary).",
  examples: ["Hiện còn nợ nhà cung cấp bao nhiêu?", "Nợ NCC An Phát còn bao nhiêu?"],
  async run(args, ctx) {
    const sup = await supplierOf(ctx, args.supplier);
    if (!sup.ok) return sup.result;
    const today = vnToday(ctx.now);
    let q = ctx.db.from("v_supplier_debt_summary").select("supplier_id, supplier_code, supplier_name, supplier_final_total, supplier_paid_total, supplier_remaining_total, supplier_open_invoice_count").order("supplier_remaining_total", { ascending: false });
    if (sup.supplier) q = q.eq("supplier_id", sup.supplier.id);
    else if (!args.includeSettled) q = q.gt("supplier_remaining_total", 0);
    const limit = Math.min(ctx.maxRows, this.maxRows);
    const [{ data, error }, overview, updatedAt] = await Promise.all([q.range(0, limit - 1), debtOverview(ctx, { from: ALL_TIME_FROM, to: today, supplierId: sup.supplier?.id ?? null, status: null, search: null }), payablesUpdatedAt(ctx)]);
    if (error) throw new ToolReadError("v_supplier_debt_summary", error.message);
    const rows = (data ?? []) as SupplierDebtRow[];
    const scope = { supplier_id: sup.supplier?.id ?? null, include_settled: args.includeSettled, to: today };
    const coverage = `Toàn bộ hóa đơn đến ${dmy(today)}${sup.supplier ? ` · NCC ${sup.supplier.name}` : ""}`;
    const source = { label: "Công nợ NCC", origin: "view v_supplier_debt_summary + RPC get_debt_overview", href: sup.supplier ? `/debts?supplier=${sup.supplier.id}` : "/debts", readAt: ctx.now.toISOString(), dataUpdatedAt: updatedAt, freshness: "manual_entry" as const, coverage };
    const caveats = [NO_DUE_DATE, "Chỉ gồm hóa đơn và thanh toán đã nhập vào hệ thống; số tiền đã gồm VAT / chiết khấu theo cách tính của hóa đơn."];
    const totals = { invoiced: vnd(overview.total_final_amount), paid: vnd(overview.total_paid_amount), remaining: vnd(overview.total_remaining_amount), open_invoices: Number(overview.open_invoice_count) };
    const list = rows.map((r) => ({ supplier: `${r.supplier_name} (${r.supplier_code})`, invoiced: vnd(r.supplier_final_total), paid: vnd(r.supplier_paid_total), remaining: vnd(r.supplier_remaining_total), open_invoices: r.supplier_open_invoice_count }));
    const lines = [
      `${coverage}: phải trả ${totals.invoiced}, đã trả ${totals.paid}, còn nợ ${totals.remaining} (${totals.open_invoices} hóa đơn chưa trả xong).`,
      ...(list.length ? [sup.supplier ? "Chi tiết:" : `NCC còn nợ nhiều nhất (${list.length}):`, ...list.map((s) => `• ${s.supplier}: còn nợ ${s.remaining} / phải trả ${s.invoiced}, ${s.open_invoices} HĐ chưa trả xong.`)] : ["Không có nhà cung cấp nào còn nợ."]),
    ];
    return done({ data: { as_of: dmy(today), totals, suppliers: list }, lines, source, rowCount: rows.length, caveats, scope, empty: Number(overview.open_invoice_count) === 0 && rows.length === 0 });
  },
};

// ------------------------------------------------------------------ get_invoices

const invoicesArgs = z
  .object({
    supplier: nameArg("Tên hoặc mã nhà cung cấp (tùy chọn)").optional(),
    status: z.enum(["open", "unpaid", "partial", "paid", "all"]).default("open").describe("open = chưa trả xong (chưa trả + trả một phần)"),
    period: periodArg.optional().describe("Lọc theo NGÀY HÓA ĐƠN (tùy chọn; mặc định toàn bộ)"),
    invoiceNo: nameArg("Số hóa đơn (tùy chọn)").optional(),
    order: z.enum(["oldest", "newest"]).default("oldest").describe("oldest = hóa đơn cũ nhất trước"),
  })
  .strict();

interface InvoiceDebtRow {
  invoice_no: string;
  invoice_date: string;
  supplier_name: string;
  supplier_code: string;
  final_amount: number;
  paid_amount: number;
  remaining_amount: number;
  payment_status: keyof typeof PAYMENT_STATUS_LABELS;
}

export const getInvoices: SystemToolDefinition<z.infer<typeof invoicesArgs>> = {
  name: "get_invoices",
  title: "Hóa đơn & tình trạng thanh toán",
  description:
    "Danh sách hóa đơn nhà cung cấp với số phải trả, đã trả, còn lại, trạng thái thanh toán và tuổi hóa đơn (số ngày từ ngày hóa đơn). Dùng cho: hóa đơn nào chưa trả, hóa đơn cũ nhất chưa trả, hóa đơn ABC đã trả chưa. Không có hạn thanh toán.",
  module: "payables",
  sensitivity: "financial",
  requiredPermissions: ["invoice:view", "debt:view"],
  input: invoicesArgs,
  timeoutMs: 8_000,
  maxRows: 20,
  freshness: "Tính trực tiếp từ hóa đơn và thanh toán đã nhập (view v_invoice_debt).",
  examples: ["Hóa đơn nào chưa thanh toán lâu nhất?", "Hóa đơn HD-0012 đã trả chưa?"],
  async run(args, ctx) {
    const sup = await supplierOf(ctx, args.supplier);
    if (!sup.ok) return sup.result;
    let from = ALL_TIME_FROM;
    let to = vnToday(ctx.now);
    let periodLabel = "toàn bộ";
    if (args.period) {
      const p = resolvePeriodArg(args.period, "this_month", ctx.now);
      if ("error" in p) return fail("invalid_args", p.error);
      ({ fromDate: from, toDate: to, label: periodLabel } = p);
    }
    const statuses = args.invoiceNo || args.status === "all" ? null : args.status === "open" ? ["unpaid", "partial"] : [args.status];
    let q = ctx.db.from("v_invoice_debt").select("invoice_no, invoice_date, supplier_name, supplier_code, final_amount, paid_amount, remaining_amount, payment_status", { count: "exact" }).gte("invoice_date", from).lte("invoice_date", to);
    if (sup.supplier) q = q.eq("supplier_id", sup.supplier.id);
    if (statuses) q = q.in("payment_status", statuses);
    if (args.invoiceNo) q = q.ilike("invoice_no", escapeIlike(args.invoiceNo));
    const asc = args.order === "oldest";
    const limit = Math.min(ctx.maxRows, this.maxRows);
    const { data, error, count } = await q.order("invoice_date", { ascending: asc }).order("invoice_no", { ascending: asc }).range(0, limit - 1);
    if (error) throw new ToolReadError("v_invoice_debt", error.message);
    const rows = (data ?? []) as InvoiceDebtRow[];
    const scope = { supplier_id: sup.supplier?.id ?? null, status: args.invoiceNo ? "any" : args.status, from, to, invoice_filter: !!args.invoiceNo };
    if (args.invoiceNo && !rows.length) return fail("not_found", `Không tìm thấy hóa đơn “${args.invoiceNo}”.`, scope);
    // totals of the SAME filtered set, by the screen's RPC (status "open" = unpaid + partial: remaining of paid is 0)
    const overview = await debtOverview(ctx, { from, to, supplierId: sup.supplier?.id ?? null, status: statuses && statuses.length === 1 ? statuses[0]! : null, search: null });
    const statusText = args.invoiceNo ? "" : args.status === "open" ? "chưa trả xong" : args.status === "all" ? "mọi trạng thái" : PAYMENT_STATUS_LABELS[args.status].toLowerCase();
    const coverage = [args.invoiceNo ? `Hóa đơn ${args.invoiceNo}` : `Hóa đơn ${statusText}`, `ngày HĐ: ${periodLabel}`, sup.supplier ? `NCC ${sup.supplier.name}` : null].filter(Boolean).join(" · ");
    const source = { label: "Hóa đơn & công nợ", origin: "view v_invoice_debt + RPC get_debt_overview", href: "/debts", readAt: ctx.now.toISOString(), dataUpdatedAt: await payablesUpdatedAt(ctx), freshness: "manual_entry" as const, coverage };
    const items = rows.map((r) => ({
      invoice: r.invoice_no,
      date: dmy(r.invoice_date),
      age_days: daysSince(r.invoice_date, ctx.now),
      supplier: `${r.supplier_name} (${r.supplier_code})`,
      total: vnd(r.final_amount),
      paid: vnd(r.paid_amount),
      remaining: vnd(r.remaining_amount),
      status: PAYMENT_STATUS_LABELS[r.payment_status] ?? r.payment_status,
    }));
    const totals = { invoices: count ?? rows.length, remaining: vnd(overview.total_remaining_amount), invoiced: vnd(overview.total_final_amount), paid: vnd(overview.total_paid_amount) };
    const lines = [
      `${coverage}: ${totals.invoices} hóa đơn${(count ?? 0) > rows.length ? ` (hiển thị ${rows.length}, ${asc ? "cũ nhất" : "mới nhất"} trước)` : ""}${statuses && statuses.length === 1 ? "" : `; còn phải trả ${totals.remaining}`}.`,
      ...items.map((i) => `• ${i.invoice} (${i.date}, ${i.age_days} ngày) · ${i.supplier}: tổng ${i.total}, đã trả ${i.paid}, còn ${i.remaining} — ${i.status}.`),
    ];
    if (!rows.length) lines.splice(0, lines.length, `Không có hóa đơn nào: ${coverage}.`);
    return done({ data: { filter: coverage, totals, invoices: items }, lines, source, rowCount: rows.length, caveats: [NO_DUE_DATE], scope, empty: !rows.length });
  },
};

// ------------------------------------------------------------------ get_payment_summary

const paymentArgs = z
  .object({
    period: periodArg.optional().describe("Theo NGÀY THANH TOÁN; mặc định tháng này"),
    supplier: nameArg("Tên hoặc mã nhà cung cấp (tùy chọn)").optional(),
  })
  .strict();

interface PaymentRow {
  payment_date: string;
  supplier_name: string;
  supplier_code: string;
  total_amount: number;
  invoice_count: number;
  invoice_numbers: string | null;
}

export const getPaymentSummary: SystemToolDefinition<z.infer<typeof paymentArgs>> = {
  name: "get_payment_summary",
  title: "Thanh toán cho nhà cung cấp",
  description: "Các lần thanh toán cho nhà cung cấp trong kỳ (theo ngày thanh toán): tổng đã trả, số lần, NCC, hóa đơn được trả. Dùng cho: tháng này đã trả NCC bao nhiêu, đã trả NCC X những gì.",
  module: "payables",
  sensitivity: "financial",
  requiredPermissions: ["payment:view"],
  input: paymentArgs,
  timeoutMs: 8_000,
  maxRows: 20,
  freshness: "Phiếu thanh toán nhập tay; cập nhật ngay khi lưu.",
  examples: ["Tháng này đã thanh toán cho NCC bao nhiêu?", "Tuần trước trả NCC An Phát những hóa đơn nào?"],
  async run(args, ctx) {
    const p = resolvePeriodArg(args.period, "this_month", ctx.now);
    if ("error" in p) return fail("invalid_args", p.error);
    const sup = await supplierOf(ctx, args.supplier);
    if (!sup.ok) return sup.result;
    const base = () => {
      let q = ctx.db.from("v_payment_summary").select("payment_date, supplier_name, supplier_code, total_amount, invoice_count, invoice_numbers", { count: "exact" }).gte("payment_date", p.fromDate).lte("payment_date", p.toDate);
      if (sup.supplier) q = q.eq("supplier_id", sup.supplier.id);
      return q.order("payment_date", { ascending: false }).order("created_at", { ascending: false });
    };
    // the period total is the sum of the view's own payment totals (≤ 1000 payments; beyond that it says so)
    const { data: all, error, count } = await base().range(0, 999);
    if (error) throw new ToolReadError("v_payment_summary", error.message);
    const rows = (all ?? []) as PaymentRow[];
    const limit = Math.min(ctx.maxRows, this.maxRows);
    const sum = rows.reduce((a, r) => a + (Number(r.total_amount) || 0), 0);
    const scope = { from: p.fromDate, to: p.toDate, supplier_id: sup.supplier?.id ?? null };
    const coverage = `${p.label}${sup.supplier ? ` · NCC ${sup.supplier.name}` : ""}`;
    const source = { label: "Lịch sử thanh toán", origin: "view v_payment_summary", href: "/payments", readAt: ctx.now.toISOString(), dataUpdatedAt: await payablesUpdatedAt(ctx), freshness: "manual_entry" as const, coverage };
    const caveats: string[] = [];
    if ((count ?? 0) > 1000) caveats.push("Có hơn 1000 lần thanh toán trong kỳ: tổng chỉ tính 1000 lần mới nhất.");
    const items = rows.slice(0, limit).map((r) => ({ date: dmy(r.payment_date), supplier: `${r.supplier_name} (${r.supplier_code})`, amount: vnd(r.total_amount), invoices: r.invoice_count, invoice_numbers: (r.invoice_numbers ?? "").slice(0, 120) }));
    if (!rows.length) return done({ data: { period: p.label, total: vnd(0), payments: 0, items: [] }, lines: [`Không có lần thanh toán nào: ${coverage}.`], source, rowCount: 0, caveats, scope, empty: true });
    const lines = [
      `Đã thanh toán ${coverage}: ${vnd(sum)} qua ${count ?? rows.length} lần${(count ?? 0) > items.length ? ` (hiển thị ${items.length} lần mới nhất)` : ""}.`,
      ...items.map((i) => `• ${i.date} · ${i.supplier}: ${i.amount} cho ${i.invoices} hóa đơn${i.invoice_numbers ? ` (${i.invoice_numbers})` : ""}.`),
    ];
    return done({ data: { period: p.label, total: vnd(sum), payments: count ?? rows.length, items }, lines, source, rowCount: items.length, caveats, scope });
  },
};

export const PAYABLES_TOOLS = [getSupplierPayables, getInvoices, getPaymentSummary] as const;
