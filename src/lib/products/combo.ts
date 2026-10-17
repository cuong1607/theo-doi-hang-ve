// ============================================================
// PHASE PRODUCT-COMBO-1: combo SKU service (migration 00056).
//
//   COMBO  = selling SKU made of ATOMIC SKUs (BOM in product_combo_components).
//            No stock, no moving average, no cost state, no ledger of its own.
//   ATOMIC = real SKU — the only source of truth for stock / cost / COGS.
//
// The BOM rules live in the database (save_combo_product, guard triggers) so
// every writer gets them; this module validates early for friendly messages,
// maps DB errors, and reads the DERIVED combo views. Combo COGS / inventory is
// the cost engine's job (cost_apply_combo_order_item via CostEngine.postSale /
// processOrder) — never re-implemented here. Money is never computed in JS:
// derived cost comes from v_combo_overview (NUMERIC in SQL).
//
// Takes the DB client as a parameter (service-role on the server, injected
// in tests).
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export type ProductType = "atomic" | "combo";

export interface ComboComponentInput {
  productId: string;
  /** Decimal string or number; must be > 0. */
  quantity: string | number;
}

export interface ComboInput {
  sku: string;
  name: string;
  unit?: string;
  currentPrice?: string | number;
  note?: string | null;
  components: ComboComponentInput[];
}

export class ComboError extends Error {
  readonly field: "sku" | "name" | "components" | null;

  constructor(message: string, field: ComboError["field"] = null) {
    super(message);
    this.name = "ComboError";
    this.field = field;
  }
}

const QTY = /^\d+(\.\d{1,4})?$/;

/**
 * Pure validation + normalisation (duplicate components merged by summing,
 * deterministic order). Atomic-ness of components is checked by the DB.
 */
export function validateComboDefinition(input: ComboInput, selfId?: string | null): { sku: string; name: string; components: Array<{ productId: string; quantity: string }> } {
  const sku = input.sku?.trim() ?? "";
  const name = input.name?.trim() ?? "";
  if (!sku) throw new ComboError("SKU combo là bắt buộc.", "sku");
  if (sku.length > 100) throw new ComboError("SKU tối đa 100 ký tự.", "sku");
  if (!name) throw new ComboError("Tên combo là bắt buộc.", "name");
  if (!input.components?.length) throw new ComboError("Combo phải có ít nhất 1 thành phần.", "components");
  const merged = new Map<string, bigint>();
  for (const c of input.components) {
    const raw = String(c.quantity ?? "").trim();
    if (!c.productId) throw new ComboError("Vui lòng chọn sản phẩm cho mọi thành phần.", "components");
    if (!QTY.test(raw)) throw new ComboError("Số lượng mỗi thành phần phải là số dương (tối đa 4 chữ số thập phân).", "components");
    const scaled = toScaled(raw);
    if (scaled <= ZERO) throw new ComboError("Số lượng mỗi thành phần phải lớn hơn 0.", "components");
    if (selfId && c.productId === selfId) throw new ComboError("Combo không thể chứa chính nó.", "components");
    merged.set(c.productId, (merged.get(c.productId) ?? ZERO) + scaled);
  }
  const components = [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([productId, q]) => ({ productId, quantity: fromScaled(q) }));
  return { sku, name, components };
}

// exact 4-decimal quantity arithmetic (quantities, not money)
const ZERO = BigInt(0);
const SCALE = BigInt(10_000);
function toScaled(v: string): bigint {
  const [i, f = ""] = v.split(".");
  return BigInt(i) * SCALE + BigInt((f + "0000").slice(0, 4));
}
function fromScaled(v: bigint): string {
  const i = v / SCALE;
  const f = (v % SCALE).toString().padStart(4, "0").replace(/0+$/, "");
  return f ? `${i}.${f}` : `${i}`;
}

/** BOM × order quantity → atomic quantities (mirror of the SQL explosion, exact). */
export function explodeComboForInventory(bom: Array<{ productId: string; quantity: string }>, orderQuantity: string): Array<{ productId: string; quantity: string }> {
  const q = toScaled(orderQuantity);
  return bom.map((c) => ({ productId: c.productId, quantity: fromScaled((toScaled(c.quantity) * q) / SCALE) }));
}

/** Derived availability: min(floor(max(stock, 0) / bom qty)); null when the BOM is empty. */
export function calculateComboAvailableQty(components: Array<{ quantity: string; quantityOnHand: string | null }>): number | null {
  if (components.length === 0) return null;
  let min: bigint | null = null;
  for (const c of components) {
    const stock = c.quantityOnHand && !c.quantityOnHand.startsWith("-") ? toScaled(c.quantityOnHand) : ZERO;
    const per = toScaled(c.quantity);
    const n = stock / per; // bigint division floors
    if (min === null || n < min) min = n;
  }
  return Number(min);
}

function mapDbError(err: { code?: string; message: string }): never {
  if (err.code === "23505") throw new ComboError("SKU đã tồn tại. Vui lòng chọn SKU khác.", "sku");
  if (err.code?.startsWith("PC")) throw new ComboError(err.message, err.code === "PC010" ? null : "components");
  throw new Error(err.message);
}

async function save(db: SupabaseClient, id: string | null, input: ComboInput): Promise<string> {
  const v = validateComboDefinition(input, id);
  const { data, error } = await db.rpc("save_combo_product", {
    p_id: id,
    p_sku: v.sku,
    p_name: v.name,
    p_unit: input.unit?.trim() || "combo",
    p_current_price: input.currentPrice === undefined || input.currentPrice === "" ? 0 : input.currentPrice,
    p_note: input.note ?? null,
    p_components: v.components.map((c) => ({ product_id: c.productId, quantity: c.quantity })),
  });
  if (error) mapDbError(error);
  return data as string;
}

export function createComboProduct(db: SupabaseClient, input: ComboInput): Promise<string> {
  return save(db, null, input);
}

/** Replaces the BOM — applies to orders costed AFTER the change; old order snapshots are untouched. */
export function updateComboProduct(db: SupabaseClient, id: string, input: ComboInput): Promise<string> {
  return save(db, id, input);
}

export interface ComboComponentView {
  productId: string;
  sku: string;
  name: string;
  quantity: string;
  isActive: boolean;
  movingAverageCost: string | null;
  quantityOnHand: string | null;
  costProvisional: boolean;
}

export interface ComboOverview {
  comboProductId: string;
  sku: string;
  name: string;
  unit: string;
  currentPrice: string;
  isActive: boolean;
  note: string | null;
  componentCount: number;
  components: ComboComponentView[];
  /** Σ component moving average × BOM qty; NULL = some component has no cost ("Chưa đủ giá vốn"). */
  currentUnitCost: string | null;
  costProvisional: boolean;
  /** Derived, never stored. NULL = empty BOM. */
  availableQty: string | null;
  mappedModels: number;
  orderLines: number;
}

type OverviewRow = {
  combo_product_id: string;
  sku: string;
  name: string;
  unit: string;
  current_price: string;
  is_active: boolean;
  note: string | null;
  component_count: number;
  components: Array<{ product_id: string; sku: string; name: string; quantity: string; is_active: boolean; moving_average_cost: string | null; quantity_on_hand: string | null; cost_provisional: boolean }> | null;
  current_unit_cost: string | null;
  cost_provisional: boolean;
  available_qty: string | null;
  mapped_models: number;
  order_lines: number;
};

const toOverview = (r: OverviewRow): ComboOverview => ({
  comboProductId: r.combo_product_id,
  sku: r.sku,
  name: r.name,
  unit: r.unit,
  currentPrice: r.current_price,
  isActive: r.is_active,
  note: r.note,
  componentCount: Number(r.component_count),
  components: (r.components ?? []).map((c) => ({
    productId: c.product_id,
    sku: c.sku,
    name: c.name,
    quantity: c.quantity,
    isActive: c.is_active,
    movingAverageCost: c.moving_average_cost,
    quantityOnHand: c.quantity_on_hand,
    costProvisional: c.cost_provisional,
  })),
  currentUnitCost: r.current_unit_cost,
  costProvisional: r.cost_provisional,
  availableQty: r.available_qty,
  mappedModels: Number(r.mapped_models),
  orderLines: Number(r.order_lines),
});

export async function getComboOverview(db: SupabaseClient, comboId: string): Promise<ComboOverview | null> {
  const { data, error } = await db.from("v_combo_overview").select("*").eq("combo_product_id", comboId).maybeSingle<OverviewRow>();
  if (error) throw new Error(error.message);
  return data ? toOverview(data) : null;
}

export async function getComboOverviews(db: SupabaseClient, comboIds: string[]): Promise<Map<string, ComboOverview>> {
  if (comboIds.length === 0) return new Map();
  const { data, error } = await db.from("v_combo_overview").select("*").in("combo_product_id", comboIds);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as OverviewRow[]).map((r) => [r.combo_product_id, toOverview(r)]));
}

export async function getComboComponents(db: SupabaseClient, comboId: string): Promise<ComboComponentView[]> {
  return (await getComboOverview(db, comboId))?.components ?? [];
}

/** Current derived cost (display only). NULL when any component has no cost. */
export async function calculateCurrentComboCost(db: SupabaseClient, comboId: string): Promise<string | null> {
  return (await getComboOverview(db, comboId))?.currentUnitCost ?? null;
}

/** Combo component snapshot of one order line (what was used — not the current BOM). */
export interface OrderItemComponentSnapshot {
  componentProductId: string;
  componentSku: string;
  quantityPerCombo: string;
  orderQuantity: string;
  totalComponentQuantity: string;
  costPerUnitSnapshot: string | null;
  componentTotalCogs: string | null;
  costProvisional: boolean;
}

export async function getOrderItemComponentSnapshots(db: SupabaseClient, orderItemIds: string[]): Promise<Map<string, OrderItemComponentSnapshot[]>> {
  const result = new Map<string, OrderItemComponentSnapshot[]>();
  if (orderItemIds.length === 0) return result;
  const { data, error } = await db
    .from("channel_order_item_cogs_components")
    .select(
      "channel_order_item_id, component_product_id, component_sku_snapshot, component_quantity_per_combo::text, order_quantity::text, total_component_quantity::text, cost_per_unit_snapshot::text, component_total_cogs::text, cost_provisional",
    )
    .in("channel_order_item_id", orderItemIds)
    .order("component_sku_snapshot");
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Array<{
    channel_order_item_id: string;
    component_product_id: string;
    component_sku_snapshot: string;
    component_quantity_per_combo: string;
    order_quantity: string;
    total_component_quantity: string;
    cost_per_unit_snapshot: string | null;
    component_total_cogs: string | null;
    cost_provisional: boolean;
  }>) {
    const list = result.get(r.channel_order_item_id) ?? [];
    list.push({
      componentProductId: r.component_product_id,
      componentSku: r.component_sku_snapshot,
      quantityPerCombo: r.component_quantity_per_combo,
      orderQuantity: r.order_quantity,
      totalComponentQuantity: r.total_component_quantity,
      costPerUnitSnapshot: r.cost_per_unit_snapshot,
      componentTotalCogs: r.component_total_cogs,
      costProvisional: r.cost_provisional,
    });
    result.set(r.channel_order_item_id, list);
  }
  return result;
}

/** Hard delete only when the combo was never used on an order; otherwise deactivate. */
export async function deleteComboProduct(db: SupabaseClient, comboId: string): Promise<"deleted" | "in_use"> {
  const [lines, snaps] = await Promise.all([
    db.from("channel_order_items").select("id", { count: "exact", head: true }).eq("internal_product_id", comboId),
    db.from("channel_order_item_cogs_components").select("id", { count: "exact", head: true }).eq("combo_product_id", comboId),
  ]);
  if (lines.error) throw new Error(lines.error.message);
  if (snaps.error) throw new Error(snaps.error.message);
  if ((lines.count ?? 0) > 0 || (snaps.count ?? 0) > 0) return "in_use";
  const { error } = await db.from("products").delete().eq("id", comboId).eq("product_type", "combo");
  if (error) throw new Error(error.message);
  return "deleted";
}
