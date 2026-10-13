// Run: node --test src/lib/channels/core/types.test.ts
//
// The TS allowed-value lists must stay identical to the CHECK constraints of
// migration 00038 (the app validates with the TS lists, the DB with the
// CHECKs) — this test reads the migration so the two can't drift silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHANNELS,
  CONNECTION_STATUSES,
  COST_METHODS,
  FINANCIAL_STATUSES,
  INVENTORY_DISPOSITIONS,
  MAPPING_STATUSES,
  SYNC_LOG_STATUSES,
  isFinancialStatus,
  isMappingStatus,
} from "./types.ts";
import { FINANCIAL_COMPONENT_CATEGORIES, FUNDED_BY, RECONCILIATION_STATUSES } from "../../financial/types.ts";
import { NotImplementedError } from "./errors.ts";
import { calculateOrderFinancials } from "../../financial/engine.ts";
import { mapShopeeEscrow, mapShopeeOrder, mapShopeePayout, mapShopeeReturn } from "../shopee/mappers.ts";

const migration = readFileSync(
  new URL("../../../../supabase/migrations/00038_shopee_financial_core.sql", import.meta.url),
  "utf8",
);

function checkList(column: string): string[] {
  const match = migration.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`));
  assert.ok(match, `CHECK for ${column} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test("TS allowed-value lists match the migration CHECK constraints", () => {
  const cases: Array<[string, readonly string[]]> = [
    ["channel", CHANNELS],
    ["provider", CHANNELS],
    ["connection_status", CONNECTION_STATUSES],
    ["mapping_status", MAPPING_STATUSES],
    ["financial_status", FINANCIAL_STATUSES],
    ["cost_method", COST_METHODS],
    ["inventory_disposition", INVENTORY_DISPOSITIONS],
    ["status", SYNC_LOG_STATUSES],
    ["category", FINANCIAL_COMPONENT_CATEGORIES],
    ["funded_by", FUNDED_BY],
    ["reconciliation_status", RECONCILIATION_STATUSES],
  ];
  for (const [column, values] of cases) {
    assert.deepEqual(checkList(column), [...values], column);
  }
});

test("type guards accept known values only", () => {
  assert.equal(isFinancialStatus("released"), true);
  assert.equal(isFinancialStatus("COMPLETED"), false, "order status is not a financial status");
  assert.equal(isMappingStatus(undefined), false);
});

test("SHOPEE-0 skeletons exist but are not implemented", () => {
  assert.throws(() => calculateOrderFinancials({} as never), NotImplementedError);
  assert.throws(() => mapShopeeOrder({} as never), NotImplementedError);
  assert.throws(() => mapShopeeEscrow({} as never), NotImplementedError);
  assert.throws(() => mapShopeeReturn({} as never), NotImplementedError);
  assert.throws(() => mapShopeePayout({} as never), NotImplementedError);
});
