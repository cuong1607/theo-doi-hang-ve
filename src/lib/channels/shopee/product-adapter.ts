// ============================================================
// PHASE SHOPEE-2: Shopee product payloads → canonical catalog shapes.
//
// The ONLY place that knows Shopee product field names. Input is the raw
// provider JSON (unknown); output is MappedChannelProduct / MappedChannelModel.
// If real Go-Live payloads differ from the documented examples, this file
// (and ./dto/product.ts) is what changes — never the sync service or the
// mapping logic.
//
// Each entry is validated on its own: one malformed item/model becomes a
// ParseIssue (logged, counted as failed) instead of failing the whole page,
// and nothing without a valid identity is ever returned for insertion.
// Pure: no I/O.
// ============================================================
import { toDecimalString } from "../core/decimal.ts";
import { SYNTHETIC_MODEL_ID, type MappedChannelModel, type MappedChannelProduct } from "../core/mapped.ts";
import type { Timestamp } from "../core/types.ts";
import {
  shopeeGetItemBaseInfoResponseSchema,
  shopeeGetItemListResponseSchema,
  shopeeGetModelListResponseSchema,
  shopeeItemBaseInfoSchema,
  shopeeItemListEntrySchema,
  shopeeModelSchema,
  type ShopeePriceInfo,
  type ShopeeStockInfo,
  type ShopeeTierVariation,
} from "./dto/product.ts";

export interface ParseIssue {
  apiName: string;
  /** Best-effort identity of the bad entry (may be null if the id itself is missing/invalid). */
  externalId: string | null;
  reason: string;
}

export interface ItemListPage {
  items: Array<{ externalItemId: string; itemStatus: string | null; updateTime: Timestamp | null; isKit: boolean | null }>;
  totalCount: number | null;
  hasNextPage: boolean;
  nextOffset: number | null;
  issues: ParseIssue[];
}

export class ShopeePayloadError extends Error {
  readonly apiName: string;

  constructor(apiName: string, reason: string) {
    super(`Payload Shopee không hợp lệ (${apiName}): ${reason}`);
    this.name = "ShopeePayloadError";
    this.apiName = apiName;
  }
}

const API = {
  itemList: "v2.product.get_item_list",
  baseInfo: "v2.product.get_item_base_info",
  modelList: "v2.product.get_model_list",
} as const;

function unixToIso(seconds: number | null | undefined): Timestamp | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Keeps the provider's SKU as sent (outer whitespace trimmed); blank → null. */
function cleanSku(value: string | null | undefined): string | null {
  return cleanText(value);
}

/** Picks the price entry for the shop currency, else the first one. */
function pickPrice(priceInfo: ShopeePriceInfo[] | null | undefined, currency?: string | null) {
  if (!priceInfo || priceInfo.length === 0) return { original: null, current: null };
  const entry = (currency && priceInfo.find((p) => p.currency === currency)) || priceInfo[0];
  return { original: toDecimalString(entry.original_price), current: toDecimalString(entry.current_price) };
}

function pickStock(stock: ShopeeStockInfo | null | undefined) {
  return {
    available: toDecimalString(stock?.summary_info?.total_available_stock),
    reserved: toDecimalString(stock?.summary_info?.total_reserved_stock),
  };
}

function describeZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function rawId(entry: unknown, key: string): string | null {
  if (entry && typeof entry === "object" && key in entry) {
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}

function envelopeError(apiName: string, parsed: { error?: string | null; message?: string | null }) {
  if (parsed.error) throw new ShopeePayloadError(apiName, `error=${parsed.error} ${parsed.message ?? ""}`.trim());
}

// ------------------------------------------------------- get_item_list

export function parseItemListPage(raw: unknown): ItemListPage {
  const parsed = shopeeGetItemListResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ShopeePayloadError(API.itemList, describeZodError(parsed.error));
  envelopeError(API.itemList, parsed.data);
  const response = parsed.data.response;
  if (!response) throw new ShopeePayloadError(API.itemList, "thiếu response");

  const issues: ParseIssue[] = [];
  const items: ItemListPage["items"] = [];
  for (const entry of response.item ?? []) {
    const result = shopeeItemListEntrySchema.safeParse(entry);
    if (!result.success) {
      issues.push({ apiName: API.itemList, externalId: rawId(entry, "item_id"), reason: describeZodError(result.error) });
      continue;
    }
    items.push({
      externalItemId: result.data.item_id,
      itemStatus: cleanText(result.data.item_status),
      updateTime: unixToIso(result.data.update_time),
      isKit: result.data.tag?.kit ?? null,
    });
  }
  return {
    items,
    totalCount: response.total_count ?? null,
    hasNextPage: response.has_next_page === true,
    nextOffset: typeof response.next_offset === "number" ? response.next_offset : null,
    issues,
  };
}

// --------------------------------------------------- get_item_base_info

export interface ParsedBaseInfo {
  products: MappedChannelProduct[];
  /** Raw entry per item id, for the latest-snapshot store. */
  rawByItemId: Map<string, unknown>;
  issues: ParseIssue[];
}

export function parseItemBaseInfo(raw: unknown, options: { currency?: string | null; kitByItemId?: Map<string, boolean | null> } = {}): ParsedBaseInfo {
  const parsed = shopeeGetItemBaseInfoResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ShopeePayloadError(API.baseInfo, describeZodError(parsed.error));
  envelopeError(API.baseInfo, parsed.data);

  const products: MappedChannelProduct[] = [];
  const rawByItemId = new Map<string, unknown>();
  const issues: ParseIssue[] = [];
  for (const entry of parsed.data.response?.item_list ?? []) {
    const result = shopeeItemBaseInfoSchema.safeParse(entry);
    if (!result.success) {
      issues.push({ apiName: API.baseInfo, externalId: rawId(entry, "item_id"), reason: describeZodError(result.error) });
      continue;
    }
    const item = result.data;
    const itemName = cleanText(item.item_name);
    if (!itemName) {
      issues.push({ apiName: API.baseInfo, externalId: item.item_id, reason: "thiếu item_name" });
      continue;
    }
    const price = pickPrice(item.price_info, options.currency);
    const stock = pickStock(item.stock_info_v2);
    products.push({
      externalItemId: item.item_id,
      itemName,
      itemSku: cleanSku(item.item_sku),
      categoryId: item.category_id == null ? null : String(item.category_id),
      itemStatus: cleanText(item.item_status),
      hasModel: item.has_model === true,
      isKit: options.kitByItemId?.get(item.item_id) ?? null,
      channelOriginalPrice: price.original,
      channelCurrentPrice: price.current,
      availableStock: stock.available,
      reservedStock: stock.reserved,
      sourceCreatedAt: unixToIso(item.create_time),
      sourceUpdatedAt: unixToIso(item.update_time),
    });
    rawByItemId.set(item.item_id, entry);
  }
  return { products, rawByItemId, issues };
}

/**
 * The internal sellable unit of a variation-less item. It carries the
 * item-level SKU/price/stock; external_model_id is the reserved NO_MODEL id
 * and is_synthetic marks that Shopee never sent it.
 */
export function syntheticModelFor(product: MappedChannelProduct, rawItem?: unknown): MappedChannelModel {
  const item = shopeeItemBaseInfoSchema.safeParse(rawItem);
  const dimension = item.success ? item.data.dimension : null;
  return {
    externalModelId: SYNTHETIC_MODEL_ID,
    isSynthetic: true,
    modelName: null,
    modelSku: product.itemSku,
    modelStatus: product.itemStatus,
    channelOriginalPrice: product.channelOriginalPrice,
    channelCurrentPrice: product.channelCurrentPrice,
    availableStock: product.availableStock,
    reservedStock: product.reservedStock,
    weight: item.success ? toDecimalString(item.data.weight) : null,
    packageLength: toDecimalString(dimension?.package_length),
    packageWidth: toDecimalString(dimension?.package_width),
    packageHeight: toDecimalString(dimension?.package_height),
  };
}

// -------------------------------------------------------- get_model_list

/** "Màu Xanh, 1m6" from tier_variation option names; null when not derivable. */
export function deriveModelName(tierIndex: number[] | null | undefined, tiers: ShopeeTierVariation[] | null | undefined): string | null {
  if (!tierIndex || tierIndex.length === 0 || !tiers || tiers.length === 0) return null;
  const parts: string[] = [];
  for (let i = 0; i < tierIndex.length; i++) {
    const option = cleanText(tiers[i]?.option_list?.[tierIndex[i]]?.option);
    if (!option) return null;
    parts.push(option);
  }
  return parts.join(", ");
}

export interface ParsedModelList {
  models: MappedChannelModel[];
  issues: ParseIssue[];
}

export function parseModelList(raw: unknown, options: { currency?: string | null } = {}): ParsedModelList {
  const parsed = shopeeGetModelListResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ShopeePayloadError(API.modelList, describeZodError(parsed.error));
  envelopeError(API.modelList, parsed.data);
  const tiers = parsed.data.response?.tier_variation;

  const models: MappedChannelModel[] = [];
  const issues: ParseIssue[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.data.response?.model ?? []) {
    const result = shopeeModelSchema.safeParse(entry);
    if (!result.success) {
      issues.push({ apiName: API.modelList, externalId: rawId(entry, "model_id"), reason: describeZodError(result.error) });
      continue;
    }
    const model = result.data;
    if (seen.has(model.model_id)) {
      issues.push({ apiName: API.modelList, externalId: model.model_id, reason: "model_id trùng trong cùng item" });
      continue;
    }
    seen.add(model.model_id);
    const price = pickPrice(model.price_info, options.currency);
    const stock = pickStock(model.stock_info_v2);
    models.push({
      externalModelId: model.model_id,
      isSynthetic: false,
      modelName: deriveModelName(model.tier_index, tiers),
      modelSku: cleanSku(model.model_sku),
      modelStatus: cleanText(model.model_status),
      channelOriginalPrice: price.original,
      channelCurrentPrice: price.current,
      availableStock: stock.available,
      reservedStock: stock.reserved,
      weight: toDecimalString(model.weight),
      packageLength: toDecimalString(model.dimension?.package_length),
      packageWidth: toDecimalString(model.dimension?.package_width),
      packageHeight: toDecimalString(model.dimension?.package_height),
    });
  }
  return { models, issues };
}
