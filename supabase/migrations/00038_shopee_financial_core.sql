-- ============================================================
-- PHASE SHOPEE-0: Shopee Financial Core — database foundation.
--
-- Schema only (see docs/shopee-financial-core.md). No sync, no OAuth, no
-- financial calculation, no seed data: every table starts empty.
--
-- Design rules enforced here:
--   * Shopee is ONE sales channel: tables are channel-generic (shops.channel,
--     shop_connections.provider) — only the CHECK lists say 'shopee' today.
--   * Every channel entity is scoped by shop_id; external ids are unique per
--     shop, never globally (5 shops later, 1 pilot shop now).
--   * Money = NUMERIC(18,2), quantities/stock = NUMERIC(18,4), timestamps =
--     timestamptz, external ids = text (no precision loss), raw = jsonb.
--   * order_status (provider lifecycle, free text validated in the app) and
--     financial_status (our lifecycle, CHECKed) are separate columns.
--   * Only NEW tables/relations: products/receipts/invoices/payments untouched.
--
-- Security (same model as 00036): the app reads/writes server-side with the
-- service-role client after its own permission check. anon gets nothing;
-- authenticated gets READ-ONLY, RLS-filtered access — and nothing at all on
-- token columns, raw API payloads or sync internals.
-- ============================================================


-- ------------------------------------------------------------
-- 1. shops — one row per connected marketplace shop
-- ------------------------------------------------------------
CREATE TABLE public.shops (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel           text        NOT NULL CHECK (channel IN ('shopee')),
  external_shop_id  text        NOT NULL,
  shop_name         text        NOT NULL,
  currency          text        CHECK (currency ~ '^[A-Z]{3}$'),
  region            text,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_shop_id)
);

-- (channel, external_shop_id) UNIQUE already indexes channel as leading column.
CREATE INDEX idx_shops_is_active ON public.shops (is_active);


-- ------------------------------------------------------------
-- 2. shop_connections — token lifecycle metadata (one per shop+provider)
--
-- *_token_encrypted are SERVER-ONLY: written/read only by the service-role
-- client, encrypted by the app layer before storage (implemented in
-- SHOPEE-1, same approach as src/lib/zalo/crypto.ts). No column privilege
-- on them is granted to authenticated (see section 14).
-- ------------------------------------------------------------
CREATE TABLE public.shop_connections (
  id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                      uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider                     text        NOT NULL DEFAULT 'shopee' CHECK (provider IN ('shopee')),
  connection_status            text        NOT NULL DEFAULT 'disconnected'
                                 CHECK (connection_status IN ('disconnected', 'connected', 'expired', 'error', 'revoked')),
  access_token_encrypted       text,
  refresh_token_encrypted      text,
  access_token_expires_at      timestamptz,
  last_token_refresh_at        timestamptz,
  last_successful_api_call_at  timestamptz,
  last_error_at                timestamptz,
  last_error_code              text,
  last_error_message           text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider)
);


-- ------------------------------------------------------------
-- 3. channel_products — listing (item) level, per shop
--
-- Not mapped to products here: an item with models is mapped per model
-- (channel_product_models.internal_product_id). A model-less item is
-- represented by a single default model row in the sync phase.
-- ------------------------------------------------------------
CREATE TABLE public.channel_products (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  external_item_id        text          NOT NULL,
  item_name               text          NOT NULL,
  item_sku                text,
  category_id             text,
  item_status             text,
  has_model               boolean       NOT NULL DEFAULT false,
  channel_original_price  numeric(18,2),
  channel_current_price   numeric(18,2),
  available_stock         numeric(18,4),
  reserved_stock          numeric(18,4),
  source_created_at       timestamptz,
  source_updated_at       timestamptz,
  last_synced_at          timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (shop_id, external_item_id)
);

-- Every channel query is shop-scoped, so secondary indexes lead with shop_id
-- (the UNIQUE above already serves plain shop_id lookups).
CREATE INDEX idx_channel_products_shop_status  ON public.channel_products (shop_id, item_status);
CREATE INDEX idx_channel_products_shop_updated ON public.channel_products (shop_id, source_updated_at);
CREATE INDEX idx_channel_products_item_sku     ON public.channel_products (item_sku);


-- ------------------------------------------------------------
-- 4. channel_product_models — variation level; THE product-mapping layer
--
-- model_sku is only the auto-match hint; internal_product_id is the source
-- of truth once mapped. Deleting a product sets the mapping to NULL (the
-- channel model survives) and the trigger below resets the status.
-- ------------------------------------------------------------
CREATE TABLE public.channel_product_models (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_product_id      uuid          NOT NULL REFERENCES public.channel_products(id) ON DELETE CASCADE,
  external_model_id       text          NOT NULL,
  model_name              text,
  model_sku               text,
  model_status            text,
  channel_original_price  numeric(18,2),
  channel_current_price   numeric(18,2),
  available_stock         numeric(18,4),
  reserved_stock          numeric(18,4),
  weight                  numeric(18,4),
  package_length          numeric(18,4),
  package_width           numeric(18,4),
  package_height          numeric(18,4),
  internal_product_id     uuid          REFERENCES public.products(id) ON DELETE SET NULL,
  mapping_status          text          NOT NULL DEFAULT 'unmapped'
                            CHECK (mapping_status IN ('unmapped', 'auto_mapped', 'manual_mapped', 'mapping_conflict')),
  mapped_at               timestamptz,
  mapped_by               uuid          REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_synced_at          timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (channel_product_id, external_model_id),
  -- A "mapped" status without a product would be a lie.
  CONSTRAINT channel_product_models_mapped_has_product CHECK (
    mapping_status NOT IN ('auto_mapped', 'manual_mapped') OR internal_product_id IS NOT NULL
  )
);

CREATE INDEX idx_channel_product_models_model_sku      ON public.channel_product_models (model_sku);
CREATE INDEX idx_channel_product_models_internal_prod  ON public.channel_product_models (internal_product_id);
CREATE INDEX idx_channel_product_models_mapping_status ON public.channel_product_models (mapping_status);

-- When the mapped product disappears (ON DELETE SET NULL fires this BEFORE
-- UPDATE trigger too) or someone clears the mapping, fall back to unmapped
-- instead of failing the CHECK above — deleting a product must never be
-- blocked by, nor delete, channel data.
CREATE OR REPLACE FUNCTION public.reset_channel_model_mapping()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.internal_product_id IS NULL AND NEW.mapping_status IN ('auto_mapped', 'manual_mapped') THEN
    NEW.mapping_status := 'unmapped';
    NEW.mapped_at := NULL;
    NEW.mapped_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reset_channel_model_mapping() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER reset_channel_model_mapping
  BEFORE UPDATE OF internal_product_id, mapping_status ON public.channel_product_models
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_channel_model_mapping();


-- ------------------------------------------------------------
-- 5. channel_orders
--
-- order_status: provider status as text (Shopee adds statuses over time;
-- validated in the app). financial_status: our own lifecycle, CHECKed.
-- channel_total_amount is what the BUYER paid — never seller settlement.
-- ------------------------------------------------------------
CREATE TABLE public.channel_orders (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  external_order_sn       text          NOT NULL,
  booking_sn              text,
  order_status            text          NOT NULL,
  financial_status        text          NOT NULL DEFAULT 'pending'
                            CHECK (financial_status IN (
                              'pending', 'estimated', 'settlement_available', 'released', 'mismatch', 'return_adjusted'
                            )),
  currency                text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_method          text,
  cod                     boolean,
  channel_total_amount    numeric(18,2),
  estimated_shipping_fee  numeric(18,2),
  reverse_shipping_fee    numeric(18,2),
  created_at_channel      timestamptz,
  paid_at_channel         timestamptz,
  pickup_done_at_channel  timestamptz,
  ship_by_date            timestamptz,
  updated_at_channel      timestamptz,
  last_synced_at          timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (shop_id, external_order_sn),
  -- Target for composite FKs that must stay inside the same shop
  -- (channel_returns.order_id + shop_id).
  UNIQUE (id, shop_id)
);

CREATE INDEX idx_channel_orders_shop_status    ON public.channel_orders (shop_id, order_status);
CREATE INDEX idx_channel_orders_shop_financial ON public.channel_orders (shop_id, financial_status);
CREATE INDEX idx_channel_orders_shop_created   ON public.channel_orders (shop_id, created_at_channel);
CREATE INDEX idx_channel_orders_shop_updated   ON public.channel_orders (shop_id, updated_at_channel);


-- ------------------------------------------------------------
-- 6. channel_order_items
--
-- No UNIQUE (order_id, external_order_item_id): Shopee's order_item_id is
-- SHARED by all items of one bundle-deal promotion, so it does not identify
-- a line. The sync phase replaces an order's items as a set instead.
-- COGS columns are filled by the future cost engine (not in this phase);
-- cost_per_unit_snapshot is frozen at calculation time, never read back
-- from products.current_price.
-- ------------------------------------------------------------
CREATE TABLE public.channel_order_items (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid          NOT NULL REFERENCES public.channel_orders(id) ON DELETE CASCADE,
  external_order_item_id  text,
  external_item_id        text          NOT NULL,
  external_model_id       text,
  item_name               text          NOT NULL,
  model_name              text,
  item_sku                text,
  model_sku               text,
  internal_product_id     uuid          REFERENCES public.products(id) ON DELETE SET NULL,
  quantity                numeric(18,4) NOT NULL CHECK (quantity > 0),
  original_unit_price     numeric(18,2),
  discounted_unit_price   numeric(18,2),
  promotion_type          text,
  promotion_id            text,
  cost_method             text          CHECK (cost_method IN ('moving_average', 'fifo', 'manual', 'unknown')),
  cost_per_unit_snapshot  numeric(18,4),
  total_cogs              numeric(18,2),
  cogs_calculated_at      timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_channel_order_items_order_id          ON public.channel_order_items (order_id);
CREATE INDEX idx_channel_order_items_internal_prod     ON public.channel_order_items (internal_product_id);
CREATE INDEX idx_channel_order_items_external_item_id  ON public.channel_order_items (external_item_id);
CREATE INDEX idx_channel_order_items_external_model_id ON public.channel_order_items (external_model_id);
CREATE INDEX idx_channel_order_items_model_sku         ON public.channel_order_items (model_sku);


-- ------------------------------------------------------------
-- 7. order_financials — one canonical P&L row per order
--
-- Sign convention (documented, enforced by the future engine — not CHECKed
-- because adjustments legitimately go both ways): every column holds a
-- POSITIVE magnitude of what its name says (a fee of 5000 is 5000, not
-- -5000), except total_adjustment_amount / *_variance / profit columns,
-- which are signed.
-- ------------------------------------------------------------
CREATE TABLE public.order_financials (
  id                              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                        uuid          NOT NULL UNIQUE REFERENCES public.channel_orders(id) ON DELETE CASCADE,

  -- Sales
  gross_original_value            numeric(18,2),
  gross_selling_value             numeric(18,2),

  -- Seller-funded discounts
  seller_discount                 numeric(18,2),
  seller_voucher                  numeric(18,2),

  -- Platform-funded support
  shopee_discount                 numeric(18,2),
  shopee_voucher                  numeric(18,2),
  other_platform_support          numeric(18,2),

  -- Platform fees
  commission_fee                  numeric(18,2),
  service_fee                     numeric(18,2),
  transaction_fee                 numeric(18,2),
  processing_fee                  numeric(18,2),
  campaign_fee                    numeric(18,2),
  affiliate_fee                   numeric(18,2),
  other_platform_fee              numeric(18,2),

  -- Shipping
  buyer_paid_shipping             numeric(18,2),
  actual_shipping_fee             numeric(18,2),
  shipping_rebate                 numeric(18,2),
  shipping_discount               numeric(18,2),
  reverse_shipping_fee            numeric(18,2),
  return_shipping_fee             numeric(18,2),

  -- Taxes
  escrow_tax                      numeric(18,2),
  withholding_vat_tax             numeric(18,2),
  withholding_pit_tax             numeric(18,2),
  withholding_cit_tax             numeric(18,2),
  other_tax                       numeric(18,2),

  -- Returns
  refund_amount                   numeric(18,2),
  seller_compensation_amount      numeric(18,2),

  -- Adjustments
  total_adjustment_amount         numeric(18,2),

  -- Settlement
  escrow_amount                   numeric(18,2),
  escrow_amount_after_adjustment  numeric(18,2),
  released_amount                 numeric(18,2),
  released_at                     timestamptz,

  -- Internal costs
  internal_cogs                   numeric(18,2),
  gift_cost                       numeric(18,2),
  packaging_cost                  numeric(18,2),
  ads_cost                        numeric(18,2),
  other_variable_cost             numeric(18,2),

  -- Profit metrics
  estimated_profit                numeric(18,2),
  actual_profit                   numeric(18,2),
  profit_after_cogs               numeric(18,2),
  contribution_profit             numeric(18,2),
  estimated_margin                numeric(9,4),
  actual_margin                   numeric(9,4),
  profit_variance                 numeric(18,2),

  -- Reconciliation
  calculated_settlement           numeric(18,2),
  settlement_variance             numeric(18,2),
  reconciliation_status           text          CHECK (reconciliation_status IN ('matched', 'warning', 'mismatch')),

  -- Versioning
  calculation_version             text,
  calculated_at                   timestamptz,

  created_at                      timestamptz   NOT NULL DEFAULT now(),
  updated_at                      timestamptz   NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- 8. order_financial_components — open-ended money lines per order
--
-- A new Shopee fee can be stored here (component_type + provider_field)
-- before order_financials grows a column for it. category / funded_by are
-- the canonical buckets the engine aggregates by, so they are CHECKed;
-- component_type / provider_field / source stay open text.
-- amount is signed from the SELLER's point of view (+ inflow, - outflow).
-- ------------------------------------------------------------
CREATE TABLE public.order_financial_components (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid          NOT NULL REFERENCES public.channel_orders(id) ON DELETE CASCADE,
  component_type    text          NOT NULL,
  provider_field    text,
  category          text          NOT NULL CHECK (category IN (
                                    'sales', 'seller_discount', 'platform_support', 'platform_fee', 'shipping',
                                    'tax', 'refund', 'compensation', 'adjustment', 'settlement', 'other'
                                  )),
  amount            numeric(18,2) NOT NULL,
  currency          text          CHECK (currency ~ '^[A-Z]{3}$'),
  funded_by         text          CHECK (funded_by IN ('seller', 'platform', 'buyer', 'third_party', 'unknown')),
  source            text          NOT NULL,
  source_synced_at  timestamptz,
  metadata          jsonb,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_financial_components_order_id       ON public.order_financial_components (order_id);
CREATE INDEX idx_order_financial_components_category       ON public.order_financial_components (category);
CREATE INDEX idx_order_financial_components_component_type ON public.order_financial_components (component_type);
CREATE INDEX idx_order_financial_components_provider_field ON public.order_financial_components (provider_field);


-- ------------------------------------------------------------
-- 9. channel_api_snapshots — raw provider payloads (append-only history)
--
-- Never read by UI. Can grow fast (one row per fetch): a retention policy
-- is planned for the sync phase (docs, section J).
-- ------------------------------------------------------------
CREATE TABLE public.channel_api_snapshots (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  entity_type         text        NOT NULL,
  entity_external_id  text        NOT NULL,
  api_name            text        NOT NULL,
  payload             jsonb       NOT NULL,
  source_updated_at   timestamptz,
  synced_at           timestamptz NOT NULL DEFAULT now()
);

-- "latest snapshot of entity X in shop S" is the main access path.
CREATE INDEX idx_channel_api_snapshots_entity    ON public.channel_api_snapshots (shop_id, entity_type, entity_external_id, synced_at DESC);
CREATE INDEX idx_channel_api_snapshots_api_name  ON public.channel_api_snapshots (api_name);
CREATE INDEX idx_channel_api_snapshots_synced_at ON public.channel_api_snapshots (synced_at);


-- ------------------------------------------------------------
-- 10. channel_returns / channel_return_items
--
-- (order_id, shop_id) is a composite FK so a return can never point at
-- another shop's order.
-- ------------------------------------------------------------
CREATE TABLE public.channel_returns (
  id                          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                     uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  order_id                    uuid          NOT NULL,
  external_return_sn          text          NOT NULL,
  status                      text,
  reason                      text,
  text_reason                 text,
  refund_amount               numeric(18,2),
  currency                    text          CHECK (currency ~ '^[A-Z]{3}$'),
  needs_logistics             boolean,
  tracking_number             text,
  reverse_logistics_status    text,
  seller_compensation_status  text,
  seller_compensation_amount  numeric(18,2),
  warehouse_arrival_status    integer,
  created_at_channel          timestamptz,
  updated_at_channel          timestamptz,
  last_synced_at              timestamptz,
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  updated_at                  timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (shop_id, external_return_sn),
  FOREIGN KEY (order_id, shop_id) REFERENCES public.channel_orders(id, shop_id) ON DELETE CASCADE
);

CREATE INDEX idx_channel_returns_order_id   ON public.channel_returns (order_id);
CREATE INDEX idx_channel_returns_shop_status  ON public.channel_returns (shop_id, status);
CREATE INDEX idx_channel_returns_shop_created ON public.channel_returns (shop_id, created_at_channel);
CREATE INDEX idx_channel_returns_shop_updated ON public.channel_returns (shop_id, updated_at_channel);

CREATE TABLE public.channel_return_items (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id              uuid          NOT NULL REFERENCES public.channel_returns(id) ON DELETE CASCADE,
  external_item_id       text          NOT NULL,
  external_model_id      text,
  internal_product_id    uuid          REFERENCES public.products(id) ON DELETE SET NULL,
  item_sku               text,
  variation_sku          text,
  quantity               numeric(18,4) NOT NULL CHECK (quantity > 0),
  refund_amount          numeric(18,2),
  inventory_disposition  text          NOT NULL DEFAULT 'pending'
                           CHECK (inventory_disposition IN ('pending', 'restock', 'damaged', 'lost', 'disposed')),
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_channel_return_items_return_id   ON public.channel_return_items (return_id);
CREATE INDEX idx_channel_return_items_internal    ON public.channel_return_items (internal_product_id);
CREATE INDEX idx_channel_return_items_disposition ON public.channel_return_items (inventory_disposition);


-- ------------------------------------------------------------
-- 11. payout_batches / payout_orders / payout_adjustments
--
-- payout_orders.order_id / payout_adjustments.order_id are nullable: a
-- payout can reference an order we have not synced (yet) — the raw
-- external_order_sn is always kept so it can be linked later.
-- ------------------------------------------------------------
CREATE TABLE public.payout_batches (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  from_currency    text          NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  from_amount      numeric(18,2) NOT NULL,
  payout_currency  text          NOT NULL CHECK (payout_currency ~ '^[A-Z]{3}$'),
  payout_amount    numeric(18,2) NOT NULL,
  exchange_rate    numeric(18,8),
  payout_time      timestamptz,
  pay_service      text,
  payee_id         text,
  created_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_payout_batches_shop_time ON public.payout_batches (shop_id, payout_time);

CREATE TABLE public.payout_orders (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id          uuid          NOT NULL REFERENCES public.payout_batches(id) ON DELETE CASCADE,
  order_id           uuid          REFERENCES public.channel_orders(id) ON DELETE SET NULL,
  external_order_sn  text          NOT NULL,
  escrow_amount      numeric(18,2) NOT NULL,
  currency           text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_payout_orders_payout_id         ON public.payout_orders (payout_id);
CREATE INDEX idx_payout_orders_order_id          ON public.payout_orders (order_id);
CREATE INDEX idx_payout_orders_external_order_sn ON public.payout_orders (external_order_sn);

CREATE TABLE public.payout_adjustments (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id          uuid          NOT NULL REFERENCES public.payout_batches(id) ON DELETE CASCADE,
  order_id           uuid          REFERENCES public.channel_orders(id) ON DELETE SET NULL,
  external_order_sn  text,
  adjustment_amount  numeric(18,2) NOT NULL,
  module             text,
  scenario           text,
  remark             text,
  adjustment_level   text,
  created_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_payout_adjustments_payout_id ON public.payout_adjustments (payout_id);
CREATE INDEX idx_payout_adjustments_order_id  ON public.payout_adjustments (order_id);
CREATE INDEX idx_payout_adjustments_module    ON public.payout_adjustments (module);
CREATE INDEX idx_payout_adjustments_scenario  ON public.payout_adjustments (scenario);


-- ------------------------------------------------------------
-- 12. channel_sync_states / channel_sync_logs
--
-- sync_type is open text (product/order/return/income/payout today),
-- validated in the app like order_status.
-- ------------------------------------------------------------
CREATE TABLE public.channel_sync_states (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  sync_type           text        NOT NULL,
  last_cursor         text,
  last_offset         integer,
  last_window_from    timestamptz,
  last_window_to      timestamptz,
  last_success_at     timestamptz,
  last_failure_at     timestamptz,
  last_error_code     text,
  last_error_message  text,
  metadata            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, sync_type)
);

CREATE TABLE public.channel_sync_logs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid        NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  sync_type        text        NOT NULL,
  started_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  status           text        NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  records_fetched  integer     NOT NULL DEFAULT 0 CHECK (records_fetched >= 0),
  records_created  integer     NOT NULL DEFAULT 0 CHECK (records_created >= 0),
  records_updated  integer     NOT NULL DEFAULT 0 CHECK (records_updated >= 0),
  records_failed   integer     NOT NULL DEFAULT 0 CHECK (records_failed >= 0),
  error_code       text,
  error_message    text,
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_channel_sync_logs_shop_type_started ON public.channel_sync_logs (shop_id, sync_type, started_at DESC);
CREATE INDEX idx_channel_sync_logs_started_at        ON public.channel_sync_logs (started_at);
CREATE INDEX idx_channel_sync_logs_status            ON public.channel_sync_logs (status);


-- ------------------------------------------------------------
-- 13. updated_at triggers (reuse public.handle_updated_at from 00001)
-- ------------------------------------------------------------
CREATE TRIGGER set_shops_updated_at                  BEFORE UPDATE ON public.shops                  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_shop_connections_updated_at       BEFORE UPDATE ON public.shop_connections       FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_channel_products_updated_at       BEFORE UPDATE ON public.channel_products       FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_channel_product_models_updated_at BEFORE UPDATE ON public.channel_product_models FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_channel_orders_updated_at         BEFORE UPDATE ON public.channel_orders         FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_channel_order_items_updated_at    BEFORE UPDATE ON public.channel_order_items    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_order_financials_updated_at       BEFORE UPDATE ON public.order_financials       FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_channel_returns_updated_at        BEFORE UPDATE ON public.channel_returns        FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_channel_return_items_updated_at   BEFORE UPDATE ON public.channel_return_items   FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_channel_sync_states_updated_at    BEFORE UPDATE ON public.channel_sync_states    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


-- ------------------------------------------------------------
-- 14. Privileges + RLS
--
-- Explicit (not relying on default privileges): anon nothing, authenticated
-- SELECT only, service_role full access (it bypasses RLS; the server
-- authorizes first via src/lib/auth/session.ts — permission channel:view /
-- channel:manage).
--
--   business data (shops, products, orders, financials, returns, payouts)
--       → SELECT for every ACTIVE user (admin/staff/viewer)
--   shop_connections → SELECT for active ADMIN, and only on non-secret
--       columns: the *_token_encrypted columns are not granted to
--       authenticated at all (column privilege), whatever the role.
--   channel_sync_states / channel_sync_logs → SELECT for active ADMIN
--   channel_api_snapshots → server-only (RLS on, no policy, no grant):
--       raw payloads may contain buyer PII.
-- ------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shops', 'shop_connections', 'channel_products', 'channel_product_models', 'channel_orders',
    'channel_order_items', 'order_financials', 'order_financial_components', 'channel_api_snapshots',
    'channel_returns', 'channel_return_items', 'payout_batches', 'payout_orders', 'payout_adjustments',
    'channel_sync_states', 'channel_sync_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'shops', 'channel_products', 'channel_product_models', 'channel_orders', 'channel_order_items',
    'order_financials', 'order_financial_components', 'channel_returns', 'channel_return_items',
    'payout_batches', 'payout_orders', 'payout_adjustments'
  ]
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format(
      'CREATE POLICY active_users_select ON public.%I FOR SELECT TO authenticated USING (public.is_active_user())', t
    );
  END LOOP;

  FOREACH t IN ARRAY ARRAY['channel_sync_states', 'channel_sync_logs'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format(
      'CREATE POLICY admins_select ON public.%I FOR SELECT TO authenticated USING (public.has_any_role(ARRAY[''admin'']))', t
    );
  END LOOP;
END;
$$;

GRANT SELECT (
  id, shop_id, provider, connection_status, access_token_expires_at, last_token_refresh_at,
  last_successful_api_call_at, last_error_at, last_error_code, last_error_message, created_at, updated_at
) ON public.shop_connections TO authenticated;

CREATE POLICY admins_select ON public.shop_connections
  FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['admin']));

-- channel_api_snapshots: RLS enabled, no policy, no authenticated grant.
