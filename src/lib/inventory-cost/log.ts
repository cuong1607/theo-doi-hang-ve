// Cost engine audit logging (one JSON line per meaningful operation:
// COST_PURCHASE_POSTED, COGS_SALE_POSTED, COST_REBUILD, COGS_REVERSAL,
// COGS_BACKFILL). Rebuilds are additionally persisted in
// inventory_cost_rebuilds by the database.
export interface CostLogEvent {
  event: string;
  productId?: string;
  sourceId?: string;
  result?: string;
}

export type CostLogger = (event: CostLogEvent) => void;

export const consoleCostLogger: CostLogger = (event) => console.info(JSON.stringify({ source: "cost", ...event }));
