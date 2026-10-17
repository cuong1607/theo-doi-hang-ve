-- ============================================================
-- PHASE SHOPEE-7: income release + payout reconciliation.
--
-- Three layers, never conflated:
--   order financial   order_financials (escrow + COGS + returns) — UNCHANGED,
--                     still the only source of order P&L
--   income release    order_income_releases: did Shopee release the money of
--                     an order, how much, when (get_escrow_list for local
--                     shops, get_payout_detail for cross-border shops)
--   payout            payout_batches / payout_orders / payout_adjustments:
--                     the disbursement batch and whether its amount is
--                     explained by its releases + adjustments
--
-- Sandbox facts (17/10/2026, VN = LOCAL shop):
--   * get_payout_detail / get_payout_info → "only applicable for cross border
--     shop". A local shop's money goes released escrow → Shopee wallet →
--     withdrawal to bank, so its payouts are WITHDRAWALS rebuilt from
--     get_wallet_transaction_list (channel_wallet_transactions).
--   * get_income_detail: income_status 1 (Released) / 2 (Pending) only; the
--     release_time_from/to format could not be made acceptable → releases
--     come from get_escrow_list (release_time window, confirmed envelope).
--
-- Rules:
--   * all money NUMERIC, all formulas here (TS only passes strings)
--   * tolerance: money_match_tolerance(currency) — the ONE place
--   * provider payout amount is immutable once stored (late corrections =
--     later payout / adjustment, never a rewrite)
--   * missing data → 'incomplete', never a false 'mismatch'
--   * manual notes / resolution never change a provider amount
--   * everything is scoped by shop (composite FKs / unique keys incl. shop)
-- ============================================================


-- ============================================================
-- A. Settings + completion time
-- ============================================================
ALTER TABLE public.channel_sync_settings
  ADD COLUMN release_stale_days integer NOT NULL DEFAULT 7 CHECK (release_stale_days BETWEEN 1 AND 90);
COMMENT ON COLUMN public.channel_sync_settings.release_stale_days IS
  'SHOPEE-7: a COMPLETED order whose income is still not released after this many days is flagged release_stale.';

-- Shopee's order detail has no complete_time: we record the channel update
-- time at which we first saw the order COMPLETED (≈ completion).
ALTER TABLE public.channel_orders ADD COLUMN completed_at_channel timestamptz;
COMMENT ON COLUMN public.channel_orders.completed_at_channel IS
  'SHOPEE-7: ≈ completion time = update_time of the first sync that saw order_status COMPLETED. Used for release aging only.';

CREATE OR REPLACE FUNCTION public.channel_orders_set_completed_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.order_status = 'COMPLETED' AND NEW.completed_at_channel IS NULL THEN
    NEW.completed_at_channel := COALESCE(NEW.updated_at_channel, now());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_orders_set_completed_at BEFORE INSERT OR UPDATE OF order_status, updated_at_channel ON public.channel_orders
  FOR EACH ROW EXECUTE FUNCTION public.channel_orders_set_completed_at();

UPDATE public.channel_orders SET completed_at_channel = COALESCE(updated_at_channel, last_synced_at, updated_at)
WHERE order_status = 'COMPLETED' AND completed_at_channel IS NULL;


-- ============================================================
-- B. Centralized monetary tolerance
-- ============================================================
CREATE OR REPLACE FUNCTION public.money_match_tolerance(p_currency text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  -- zero-decimal currencies: 1 unit; everything else: one minor unit
  SELECT CASE WHEN upper(COALESCE(p_currency, '')) IN ('VND', 'IDR', 'JPY', 'KRW', 'CLP') THEN 1::numeric ELSE 0.01::numeric END
$$;
COMMENT ON FUNCTION public.money_match_tolerance(text) IS
  'SHOPEE-7: |difference| <= this → matched. The only release/payout tolerance.';


-- ============================================================
-- C. Order income release
-- ============================================================
CREATE TABLE public.order_income_releases (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                  uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  -- NULL while the order is not stored locally (linked automatically when it arrives)
  order_id                 uuid,
  external_order_sn        text          NOT NULL,
  release_source           text          NOT NULL CHECK (release_source IN ('escrow_list', 'payout_detail', 'fixture')),
  released_amount          numeric(18,2) NOT NULL,
  income_currency          text          NOT NULL CHECK (income_currency ~ '^[A-Z]{3}$'),
  actual_payout_time       timestamptz,
  payment_method           text,
  -- reconciliation (reconcile_order_release; never written by the app)
  expected_amount          numeric(18,2),
  later_adjustment_amount  numeric(18,2) NOT NULL DEFAULT 0,
  difference_amount        numeric(18,2),
  release_status           text          NOT NULL DEFAULT 'released' CHECK (release_status IN ('released', 'reconciled', 'mismatch')),
  reconciled_at            timestamptz,
  first_seen_at            timestamptz   NOT NULL DEFAULT now(),
  income_synced_at         timestamptz   NOT NULL DEFAULT now(),
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (shop_id, external_order_sn),
  FOREIGN KEY (order_id, shop_id) REFERENCES public.channel_orders(id, shop_id) ON DELETE SET NULL (order_id)
);
CREATE UNIQUE INDEX idx_order_income_releases_order ON public.order_income_releases (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_order_income_releases_shop_time ON public.order_income_releases (shop_id, actual_payout_time DESC);
CREATE INDEX idx_order_income_releases_status ON public.order_income_releases (shop_id, release_status);
CREATE TRIGGER set_order_income_releases_updated_at BEFORE UPDATE ON public.order_income_releases FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
COMMENT ON TABLE public.order_income_releases IS
  'SHOPEE-7: one row per released order. released = confirmed by Shopee; reconciled = released + later order adjustments match actual_shopee_income within money_match_tolerance; mismatch otherwise. NOT the P&L source.';


-- ============================================================
-- D. Income overview snapshots (monitoring only)
-- ============================================================
CREATE TABLE public.channel_income_overviews (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                  uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  currency                 text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  pending_amount           numeric(18,2),
  released_amount          numeric(18,2),
  local_pending_amount     numeric(18,2) NOT NULL,
  local_pending_orders     integer       NOT NULL,
  local_released_amount    numeric(18,2) NOT NULL,
  pending_difference       numeric(18,2),
  released_difference      numeric(18,2),
  payload                  jsonb         NOT NULL,
  fetched_at               timestamptz   NOT NULL,
  created_at               timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX idx_channel_income_overviews_shop ON public.channel_income_overviews (shop_id, fetched_at DESC);
COMMENT ON TABLE public.channel_income_overviews IS
  'SHOPEE-7: get_income_overview totals vs local aggregates. Monitoring only — never used to change order data. Kept 90 days.';


-- ============================================================
-- E. Wallet ledger (local shops: source of withdrawals = payouts)
-- ============================================================
CREATE TABLE public.channel_wallet_transactions (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                   uuid          NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider_transaction_id   text          NOT NULL,
  transaction_type          text          NOT NULL,
  -- normalized by the provider mapper (sign convention: + money in, − money out)
  kind                      text          NOT NULL CHECK (kind IN ('escrow_release', 'withdrawal', 'withdrawal_completed', 'withdrawal_cancelled', 'adjustment')),
  amount                    numeric(18,2) NOT NULL,
  current_balance           numeric(18,2),
  currency                  text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at               timestamptz   NOT NULL,
  external_order_sn         text,
  withdrawal_id             text,
  provider_status           text,
  description               text,
  payload                   jsonb         NOT NULL,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (shop_id, provider_transaction_id)
);
CREATE INDEX idx_channel_wallet_tx_shop_time ON public.channel_wallet_transactions (shop_id, occurred_at, provider_transaction_id);
CREATE INDEX idx_channel_wallet_tx_withdrawal ON public.channel_wallet_transactions (shop_id, withdrawal_id) WHERE withdrawal_id IS NOT NULL;
COMMENT ON TABLE public.channel_wallet_transactions IS
  'SHOPEE-7: Shopee wallet ledger of LOCAL shops (get_wallet_transaction_list). Immutable provider history; payouts are rebuilt from it.';


-- ============================================================
-- F. Payout domain (reuse SHOPEE-0 tables)
-- ============================================================
ALTER TABLE public.shops
  ADD COLUMN payout_source text CHECK (payout_source IN ('payout_detail', 'wallet'));
COMMENT ON COLUMN public.shops.payout_source IS
  'SHOPEE-7: how payouts are obtained — payout_detail (cross-border shops) or wallet (local shops). NULL = not detected yet.';

ALTER TABLE public.payout_batches
  ADD COLUMN provider_payout_id     text,
  ADD COLUMN payout_source          text CHECK (payout_source IN ('payout_detail', 'wallet', 'fixture')),
  ADD COLUMN payout_status          text NOT NULL DEFAULT 'completed' CHECK (payout_status IN ('pending', 'completed', 'cancelled')),
  ADD COLUMN payment_method         text,
  ADD COLUMN bank_reference         text,
  ADD COLUMN opening_balance        numeric(18,2),
  ADD COLUMN closing_balance        numeric(18,2),
  ADD COLUMN orders_released_total  numeric(18,2),
  ADD COLUMN adjustments_total      numeric(18,2),
  ADD COLUMN expected_amount        numeric(18,2),
  ADD COLUMN difference_amount      numeric(18,2),
  ADD COLUMN order_count            integer NOT NULL DEFAULT 0,
  ADD COLUMN missing_order_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN adjustment_count       integer NOT NULL DEFAULT 0,
  ADD COLUMN reconciliation_status  text NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN ('pending', 'incomplete', 'matched', 'mismatch')),
  ADD COLUMN incomplete_reason      text,
  ADD COLUMN reconciled_at          timestamptz,
  ADD COLUMN last_provider_amount   numeric(18,2),
  ADD COLUMN resolution_status      text NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open', 'investigating', 'resolved', 'accepted')),
  ADD COLUMN resolution_reason      text,
  ADD COLUMN resolved_at            timestamptz,
  ADD COLUMN resolved_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN synced_at              timestamptz,
  ADD COLUMN updated_at             timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX idx_payout_batches_provider_id ON public.payout_batches (shop_id, provider_payout_id);
CREATE INDEX idx_payout_batches_recon ON public.payout_batches (shop_id, reconciliation_status);
CREATE TRIGGER set_payout_batches_updated_at BEFORE UPDATE ON public.payout_batches FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
COMMENT ON COLUMN public.payout_batches.expected_amount IS
  'SHOPEE-7: Σ payout_orders.escrow_amount + Σ payout_adjustments.adjustment_amount + COALESCE(opening_balance,0) − COALESCE(closing_balance,0). Balances only for wallet payouts.';
COMMENT ON COLUMN public.payout_batches.last_provider_amount IS
  'SHOPEE-7: a later sync reported a different amount for an already stored payout — kept here, payout_amount is never rewritten.';

-- provider amount immutable
CREATE OR REPLACE FUNCTION public.guard_payout_amount() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.payout_amount IS DISTINCT FROM OLD.payout_amount OR NEW.payout_currency IS DISTINCT FROM OLD.payout_currency THEN
    RAISE EXCEPTION 'Số tiền payout của Shopee không được sửa (payout %).', OLD.provider_payout_id USING ERRCODE = 'PO001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_payout_amount BEFORE UPDATE OF payout_amount, payout_currency ON public.payout_batches
  FOR EACH ROW EXECUTE FUNCTION public.guard_payout_amount();

ALTER TABLE public.payout_orders
  ADD COLUMN expected_amount          numeric(18,2),
  ADD COLUMN difference_amount        numeric(18,2),
  ADD COLUMN allocated_payout_amount  numeric(18,2),
  ADD COLUMN occurred_at              timestamptz;
COMMENT ON COLUMN public.payout_orders.escrow_amount IS 'Released amount of this order inside the payout (provider value).';
CREATE UNIQUE INDEX idx_payout_orders_identity ON public.payout_orders (payout_id, external_order_sn);

ALTER TABLE public.payout_adjustments
  ADD COLUMN provider_adjustment_id  text,
  ADD COLUMN adjustment_type         text,
  ADD COLUMN description             text,
  ADD COLUMN currency                text CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN occurred_at             timestamptz,
  ADD COLUMN raw_reference           jsonb;
CREATE UNIQUE INDEX idx_payout_adjustments_identity ON public.payout_adjustments (payout_id, provider_adjustment_id);
CREATE INDEX idx_payout_adjustments_order_time ON public.payout_adjustments (order_id, occurred_at) WHERE order_id IS NOT NULL;

CREATE TABLE public.payout_reconciliation_notes (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id          uuid        NOT NULL REFERENCES public.payout_batches(id) ON DELETE CASCADE,
  note               text        NOT NULL CHECK (length(btrim(note)) > 0),
  resolution_status  text        CHECK (resolution_status IN ('open', 'investigating', 'resolved', 'accepted')),
  resolution_reason  text,
  difference_at_note numeric(18,2),
  created_by         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payout_reconciliation_notes_payout ON public.payout_reconciliation_notes (payout_id, created_at DESC);
COMMENT ON TABLE public.payout_reconciliation_notes IS
  'SHOPEE-7: audit of manual reconciliation notes / resolution changes. Never changes provider amounts or the computed difference.';


-- ============================================================
-- G. Reconciliation functions
-- ============================================================

-- One order: expected = actual_shopee_income (escrow after adjustment, incl.
-- returns); actual = released + order-linked payout adjustments AFTER the
-- release (late corrections live in later payouts — no double counting).
CREATE OR REPLACE FUNCTION public.reconcile_order_release(p_release_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  r         public.order_income_releases%ROWTYPE;
  v_exp     numeric;
  v_cur     text;
  v_later   numeric := 0;
  v_diff    numeric;
  v_status  text;
BEGIN
  SELECT * INTO r FROM public.order_income_releases WHERE id = p_release_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.order_id IS NOT NULL THEN
    SELECT f.actual_shopee_income, o.currency INTO v_exp, v_cur
    FROM public.channel_orders o LEFT JOIN public.order_financials f ON f.order_id = o.id
    WHERE o.id = r.order_id;
    SELECT COALESCE(sum(a.adjustment_amount), 0) INTO v_later
    FROM public.payout_adjustments a JOIN public.payout_batches b ON b.id = a.payout_id
    WHERE a.order_id = r.order_id AND b.shop_id = r.shop_id
      AND a.occurred_at IS NOT NULL AND r.actual_payout_time IS NOT NULL AND a.occurred_at > r.actual_payout_time;
  END IF;

  IF v_exp IS NULL OR v_cur IS DISTINCT FROM r.income_currency THEN
    v_diff := NULL;
    v_status := 'released';          -- confirmed, not comparable (yet)
  ELSE
    v_diff := (r.released_amount + v_later) - v_exp;
    v_status := CASE WHEN abs(v_diff) <= public.money_match_tolerance(r.income_currency) THEN 'reconciled' ELSE 'mismatch' END;
  END IF;

  UPDATE public.order_income_releases
  SET expected_amount = v_exp, later_adjustment_amount = v_later, difference_amount = v_diff, release_status = v_status,
      reconciled_at = CASE WHEN v_status = 'released' THEN NULL ELSE now() END
  WHERE id = p_release_id
    AND (expected_amount IS DISTINCT FROM v_exp OR later_adjustment_amount IS DISTINCT FROM v_later
         OR difference_amount IS DISTINCT FROM v_diff OR release_status IS DISTINCT FROM v_status);
  RETURN v_status;
END;
$$;

-- Batch write of released entries (one get_escrow_list page / one payout's
-- escrow list). Entries: [{order_sn, amount, currency, release_time, payment_method}].
CREATE OR REPLACE FUNCTION public.apply_income_releases(p_shop_id uuid, p_source text, p_entries jsonb, p_synced_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  e         jsonb;
  v_id      uuid;
  v_order   uuid;
  v_old     public.order_income_releases%ROWTYPE;
  v_created int := 0;
  v_changed int := 0;
  v_same    int := 0;
  v_linked  int := 0;
  v_unlinked int := 0;
  v_amount  numeric;
  v_time    timestamptz;
BEGIN
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb)) LOOP
    v_amount := (e->>'amount')::numeric;
    v_time := NULLIF(e->>'release_time', '')::timestamptz;
    SELECT o.id INTO v_order FROM public.channel_orders o WHERE o.shop_id = p_shop_id AND o.external_order_sn = e->>'order_sn';
    SELECT * INTO v_old FROM public.order_income_releases WHERE shop_id = p_shop_id AND external_order_sn = e->>'order_sn' FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.order_income_releases (shop_id, order_id, external_order_sn, release_source, released_amount, income_currency, actual_payout_time, payment_method, first_seen_at, income_synced_at)
      VALUES (p_shop_id, v_order, e->>'order_sn', p_source, v_amount, upper(e->>'currency'), v_time, NULLIF(e->>'payment_method', ''), p_synced_at, p_synced_at)
      RETURNING id INTO v_id;
      v_created := v_created + 1;
      -- audit history of the provider value
      INSERT INTO public.channel_api_snapshots (shop_id, entity_type, entity_external_id, api_name, payload, source_updated_at, synced_at, fingerprint)
      VALUES (p_shop_id, 'income', e->>'order_sn', COALESCE(e->>'api_name', p_source), e, v_time, p_synced_at, md5(v_amount::text || '|' || COALESCE(v_time::text, '')));
    ELSE
      v_id := v_old.id;
      IF v_old.released_amount IS DISTINCT FROM v_amount OR v_old.actual_payout_time IS DISTINCT FROM v_time THEN
        v_changed := v_changed + 1;
        INSERT INTO public.channel_api_snapshots (shop_id, entity_type, entity_external_id, api_name, payload, source_updated_at, synced_at, fingerprint)
        VALUES (p_shop_id, 'income', e->>'order_sn', COALESCE(e->>'api_name', p_source), e, v_time, p_synced_at, md5(v_amount::text || '|' || COALESCE(v_time::text, '')));
      ELSE
        v_same := v_same + 1;
      END IF;
      UPDATE public.order_income_releases
      SET order_id = COALESCE(order_id, v_order), released_amount = v_amount, income_currency = upper(e->>'currency'),
          actual_payout_time = v_time, payment_method = COALESCE(NULLIF(e->>'payment_method', ''), payment_method), income_synced_at = p_synced_at
      WHERE id = v_id;
    END IF;
    IF v_order IS NULL THEN v_unlinked := v_unlinked + 1; ELSE v_linked := v_linked + 1; END IF;
    PERFORM public.reconcile_order_release(v_id);
  END LOOP;
  RETURN jsonb_build_object('created', v_created, 'changed', v_changed, 'unchanged', v_same, 'linked', v_linked, 'unlinked', v_unlinked);
END;
$$;

-- Payout: link orders, compare each order with its expected income, totals,
-- status. Pure function of stored data — safe to call any number of times.
CREATE OR REPLACE FUNCTION public.reconcile_payout(p_payout_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  b          public.payout_batches%ROWTYPE;
  v_orders   numeric;
  v_adj      numeric;
  v_n        int;
  v_missing  int;
  v_nadj     int;
  v_curbad   int;
  v_expected numeric;
  v_diff     numeric;
  v_status   text;
  v_reason   text;
BEGIN
  SELECT * INTO b FROM public.payout_batches WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.payout_orders po SET order_id = o.id
  FROM public.channel_orders o
  WHERE po.payout_id = b.id AND po.order_id IS NULL AND o.shop_id = b.shop_id AND o.external_order_sn = po.external_order_sn;
  UPDATE public.payout_adjustments pa SET order_id = o.id
  FROM public.channel_orders o
  WHERE pa.payout_id = b.id AND pa.order_id IS NULL AND pa.external_order_sn IS NOT NULL AND o.shop_id = b.shop_id AND o.external_order_sn = pa.external_order_sn;

  UPDATE public.payout_orders po
  SET expected_amount = f.actual_shopee_income,
      difference_amount = CASE WHEN f.actual_shopee_income IS NULL THEN NULL ELSE po.escrow_amount - f.actual_shopee_income END
  FROM public.order_financials f
  WHERE po.payout_id = b.id AND f.order_id = po.order_id
    AND (po.expected_amount IS DISTINCT FROM f.actual_shopee_income);

  SELECT COALESCE(sum(escrow_amount), 0), count(*), count(*) FILTER (WHERE order_id IS NULL),
         count(*) FILTER (WHERE currency <> b.payout_currency)
  INTO v_orders, v_n, v_missing, v_curbad FROM public.payout_orders WHERE payout_id = b.id;
  SELECT COALESCE(sum(adjustment_amount), 0), count(*), v_curbad + count(*) FILTER (WHERE currency IS NOT NULL AND currency <> b.payout_currency)
  INTO v_adj, v_nadj, v_curbad FROM public.payout_adjustments WHERE payout_id = b.id;

  v_expected := v_orders + v_adj + COALESCE(b.opening_balance, 0) - COALESCE(b.closing_balance, 0);
  v_diff := b.payout_amount - v_expected;

  IF b.payout_status <> 'completed' THEN
    v_status := 'pending'; v_reason := b.payout_status;
  ELSIF v_curbad > 0 THEN
    v_status := 'incomplete'; v_reason := 'currency_mismatch';
  ELSIF b.payout_source = 'wallet' AND (b.opening_balance IS NULL OR b.closing_balance IS NULL) THEN
    v_status := 'incomplete'; v_reason := 'balance_unknown';
  ELSIF v_missing > 0 THEN
    v_status := 'incomplete'; v_reason := 'orders_missing';
  ELSIF abs(v_diff) <= public.money_match_tolerance(b.payout_currency) THEN
    v_status := 'matched'; v_reason := NULL;
  ELSE
    v_status := 'mismatch'; v_reason := NULL;
  END IF;

  UPDATE public.payout_batches
  SET orders_released_total = v_orders, adjustments_total = v_adj, expected_amount = v_expected, difference_amount = v_diff,
      order_count = v_n, missing_order_count = v_missing, adjustment_count = v_nadj,
      reconciliation_status = v_status, incomplete_reason = v_reason,
      reconciled_at = CASE WHEN v_status IN ('matched', 'mismatch') THEN COALESCE(reconciled_at, now()) ELSE NULL END
  WHERE id = b.id
    AND (orders_released_total IS DISTINCT FROM v_orders OR adjustments_total IS DISTINCT FROM v_adj OR expected_amount IS DISTINCT FROM v_expected
         OR difference_amount IS DISTINCT FROM v_diff OR order_count IS DISTINCT FROM v_n OR missing_order_count IS DISTINCT FROM v_missing
         OR adjustment_count IS DISTINCT FROM v_nadj OR reconciliation_status IS DISTINCT FROM v_status OR incomplete_reason IS DISTINCT FROM v_reason);

  -- order-level releases of this payout's orders can now see late adjustments
  PERFORM public.reconcile_order_release(r.id)
  FROM public.order_income_releases r
  WHERE r.shop_id = b.shop_id AND r.order_id IN (SELECT order_id FROM public.payout_adjustments WHERE payout_id = b.id AND order_id IS NOT NULL);
  RETURN v_status;
END;
$$;

-- One provider payout (get_payout_detail / fixture). Idempotent; the amount
-- of an existing payout is never rewritten (a different one → last_provider_amount).
-- p_payout: {provider_payout_id, payout_amount, payout_currency, from_amount,
--   from_currency, exchange_rate, payout_time, pay_service, payee_id,
--   payment_method, payout_status}
-- p_orders: [{order_sn, amount, currency, occurred_at}]
-- p_adjustments: [{provider_adjustment_id, adjustment_type, description, amount,
--   currency, order_sn, module, scenario, remark, adjustment_level, occurred_at, raw}]
CREATE OR REPLACE FUNCTION public.apply_payout(p_shop_id uuid, p_source text, p_payout jsonb, p_orders jsonb, p_adjustments jsonb, p_synced_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_id       uuid;
  v_old      public.payout_batches%ROWTYPE;
  v_amount   numeric := (p_payout->>'payout_amount')::numeric;
  v_created  boolean := false;
  v_conflict boolean := false;
  v_status   text;
BEGIN
  SELECT * INTO v_old FROM public.payout_batches WHERE shop_id = p_shop_id AND provider_payout_id = p_payout->>'provider_payout_id' FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.payout_batches (shop_id, provider_payout_id, payout_source, from_currency, from_amount, payout_currency, payout_amount,
      exchange_rate, payout_time, pay_service, payee_id, payment_method, payout_status, synced_at)
    VALUES (p_shop_id, p_payout->>'provider_payout_id', p_source,
      upper(COALESCE(p_payout->>'from_currency', p_payout->>'payout_currency')), COALESCE((p_payout->>'from_amount')::numeric, v_amount),
      upper(p_payout->>'payout_currency'), v_amount, NULLIF(p_payout->>'exchange_rate', '')::numeric,
      NULLIF(p_payout->>'payout_time', '')::timestamptz, p_payout->>'pay_service', p_payout->>'payee_id', p_payout->>'payment_method',
      COALESCE(p_payout->>'payout_status', 'completed'), p_synced_at)
    RETURNING id INTO v_id;
    v_created := true;
  ELSE
    v_id := v_old.id;
    v_conflict := v_old.payout_amount IS DISTINCT FROM v_amount;
    UPDATE public.payout_batches
    SET payout_status = COALESCE(p_payout->>'payout_status', payout_status),
        payment_method = COALESCE(p_payout->>'payment_method', payment_method),
        last_provider_amount = CASE WHEN v_conflict THEN v_amount ELSE last_provider_amount END,
        synced_at = p_synced_at
    WHERE id = v_id;
  END IF;

  INSERT INTO public.payout_orders (payout_id, external_order_sn, escrow_amount, currency, occurred_at)
  SELECT v_id, x->>'order_sn', (x->>'amount')::numeric, upper(x->>'currency'), NULLIF(x->>'occurred_at', '')::timestamptz
  FROM jsonb_array_elements(COALESCE(p_orders, '[]'::jsonb)) x
  ON CONFLICT (payout_id, external_order_sn) DO NOTHING;

  INSERT INTO public.payout_adjustments (payout_id, provider_adjustment_id, adjustment_type, description, adjustment_amount, currency,
    external_order_sn, module, scenario, remark, adjustment_level, occurred_at, raw_reference)
  SELECT v_id, x->>'provider_adjustment_id', x->>'adjustment_type', x->>'description', (x->>'amount')::numeric, upper(x->>'currency'),
    NULLIF(x->>'order_sn', ''), x->>'module', x->>'scenario', x->>'remark', x->>'adjustment_level', NULLIF(x->>'occurred_at', '')::timestamptz, x->'raw'
  FROM jsonb_array_elements(COALESCE(p_adjustments, '[]'::jsonb)) x
  ON CONFLICT (payout_id, provider_adjustment_id) DO NOTHING;

  v_status := public.reconcile_payout(v_id);
  RETURN jsonb_build_object('payout_id', v_id, 'created', v_created, 'amount_conflict', v_conflict, 'reconciliation_status', v_status);
END;
$$;

-- Wallet ledger rows (idempotent by provider transaction id).
-- p_rows: [{provider_transaction_id, transaction_type, kind, amount, current_balance,
--   currency, occurred_at, order_sn, withdrawal_id, provider_status, description, payload}]
CREATE OR REPLACE FUNCTION public.apply_wallet_transactions(p_shop_id uuid, p_rows jsonb)
RETURNS integer LANGUAGE sql SET search_path = '' AS $$
  WITH ins AS (
    INSERT INTO public.channel_wallet_transactions (shop_id, provider_transaction_id, transaction_type, kind, amount, current_balance, currency,
      occurred_at, external_order_sn, withdrawal_id, provider_status, description, payload)
    SELECT p_shop_id, x->>'provider_transaction_id', x->>'transaction_type', x->>'kind', (x->>'amount')::numeric,
      NULLIF(x->>'current_balance', '')::numeric, upper(x->>'currency'), (x->>'occurred_at')::timestamptz,
      NULLIF(x->>'order_sn', ''), NULLIF(x->>'withdrawal_id', ''), NULLIF(x->>'provider_status', ''), NULLIF(x->>'description', ''), COALESCE(x->'payload', '{}'::jsonb)
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) x
    ON CONFLICT (shop_id, provider_transaction_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int FROM ins
$$;

-- Local shops: every withdrawal is one payout. Its interval is (previous
-- withdrawal, this withdrawal]; escrow releases in it are its orders, every
-- other money movement an adjustment, and the wallet balance before/after
-- closes the identity:
--   withdrawal = opening_balance + Σ releases + Σ adjustments − closing_balance
-- A frozen payout (matched & final, or resolved/accepted) is never rebuilt.
CREATE OR REPLACE FUNCTION public.build_wallet_payouts(p_shop_id uuid, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  w         public.channel_wallet_transactions%ROWTYPE;
  prev      public.channel_wallet_transactions%ROWTYPE;
  b         public.payout_batches%ROWTYPE;
  v_key     text;
  v_id      uuid;
  v_status  text;
  v_open    numeric;
  v_first   public.channel_wallet_transactions%ROWTYPE;
  v_has_prev boolean;
  v_built   int := 0;
  v_frozen  int := 0;
BEGIN
  FOR w IN
    SELECT * FROM public.channel_wallet_transactions
    WHERE shop_id = p_shop_id AND kind = 'withdrawal'
    ORDER BY occurred_at, provider_transaction_id
  LOOP
    EXIT WHEN v_built >= p_limit;
    v_key := COALESCE(w.withdrawal_id, w.provider_transaction_id);
    SELECT * INTO b FROM public.payout_batches WHERE shop_id = p_shop_id AND provider_payout_id = v_key FOR UPDATE;
    IF FOUND AND (b.resolution_status IN ('resolved', 'accepted') OR (b.reconciliation_status = 'matched' AND b.payout_status <> 'pending')) THEN
      v_frozen := v_frozen + 1;
      CONTINUE;
    END IF;

    v_status := CASE
      WHEN EXISTS (SELECT 1 FROM public.channel_wallet_transactions c WHERE c.shop_id = p_shop_id AND c.kind = 'withdrawal_cancelled' AND c.withdrawal_id = w.withdrawal_id) THEN 'cancelled'
      WHEN EXISTS (SELECT 1 FROM public.channel_wallet_transactions c WHERE c.shop_id = p_shop_id AND c.kind = 'withdrawal_completed' AND c.withdrawal_id = w.withdrawal_id)
        OR upper(COALESCE(w.provider_status, '')) IN ('COMPLETED', 'SUCCESS', 'SUCCESSFUL') THEN 'completed'
      ELSE 'pending'
    END;

    SELECT * INTO prev FROM public.channel_wallet_transactions
    WHERE shop_id = p_shop_id AND kind = 'withdrawal' AND (occurred_at, provider_transaction_id) < (w.occurred_at, w.provider_transaction_id)
    ORDER BY occurred_at DESC, provider_transaction_id DESC LIMIT 1;
    v_has_prev := FOUND;

    IF v_has_prev THEN
      v_open := prev.current_balance;
    ELSE
      -- first withdrawal we know: balance before the first movement of its interval
      SELECT * INTO v_first FROM public.channel_wallet_transactions
      WHERE shop_id = p_shop_id AND kind NOT IN ('withdrawal_completed') AND (occurred_at, provider_transaction_id) <= (w.occurred_at, w.provider_transaction_id)
      ORDER BY occurred_at, provider_transaction_id LIMIT 1;
      v_open := v_first.current_balance - v_first.amount;
    END IF;

    IF b.id IS NULL THEN
      INSERT INTO public.payout_batches (shop_id, provider_payout_id, payout_source, from_currency, from_amount, payout_currency, payout_amount,
        payout_time, payout_status, opening_balance, closing_balance, payment_method, synced_at)
      VALUES (p_shop_id, v_key, 'wallet', w.currency, -w.amount, w.currency, -w.amount, w.occurred_at, v_status, v_open, w.current_balance, 'wallet_withdrawal', now())
      ON CONFLICT (shop_id, provider_payout_id) DO NOTHING
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        SELECT id INTO v_id FROM public.payout_batches WHERE shop_id = p_shop_id AND provider_payout_id = v_key;
      END IF;
    ELSE
      v_id := b.id;
      UPDATE public.payout_batches SET payout_status = v_status, opening_balance = v_open, closing_balance = w.current_balance, synced_at = now() WHERE id = v_id;
    END IF;

    -- membership is derived → rebuilt (only while not frozen)
    DELETE FROM public.payout_orders WHERE payout_id = v_id;
    DELETE FROM public.payout_adjustments WHERE payout_id = v_id;

    INSERT INTO public.payout_orders (payout_id, external_order_sn, escrow_amount, currency, occurred_at)
    SELECT v_id, t.external_order_sn, sum(t.amount), min(t.currency), min(t.occurred_at)
    FROM public.channel_wallet_transactions t
    WHERE t.shop_id = p_shop_id AND t.kind = 'escrow_release' AND t.external_order_sn IS NOT NULL
      AND (NOT v_has_prev OR (t.occurred_at, t.provider_transaction_id) > (prev.occurred_at, prev.provider_transaction_id))
      AND (t.occurred_at, t.provider_transaction_id) < (w.occurred_at, w.provider_transaction_id)
    GROUP BY t.external_order_sn;

    INSERT INTO public.payout_adjustments (payout_id, provider_adjustment_id, adjustment_type, description, adjustment_amount, currency,
      external_order_sn, module, occurred_at, raw_reference)
    SELECT v_id, t.provider_transaction_id, lower(t.transaction_type), t.description, t.amount, t.currency, t.external_order_sn, 'wallet', t.occurred_at,
      jsonb_build_object('transaction_type', t.transaction_type, 'withdrawal_id', t.withdrawal_id)
    FROM public.channel_wallet_transactions t
    WHERE t.shop_id = p_shop_id
      AND (t.kind IN ('adjustment', 'withdrawal_cancelled') OR (t.kind = 'escrow_release' AND t.external_order_sn IS NULL))
      AND (NOT v_has_prev OR (t.occurred_at, t.provider_transaction_id) > (prev.occurred_at, prev.provider_transaction_id))
      AND (t.occurred_at, t.provider_transaction_id) < (w.occurred_at, w.provider_transaction_id);

    PERFORM public.reconcile_payout(v_id);
    v_built := v_built + 1;
  END LOOP;
  RETURN jsonb_build_object('built', v_built, 'frozen', v_frozen);
END;
$$;

-- Re-run reconciliation for a shop's payouts that are not final yet (orders
-- may have arrived, escrow may have changed). Bounded.
CREATE OR REPLACE FUNCTION public.reconcile_open_payouts(p_shop_id uuid, p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_id uuid; v_n int := 0;
BEGIN
  FOR v_id IN
    SELECT id FROM public.payout_batches
    WHERE shop_id = p_shop_id AND reconciliation_status IN ('pending', 'incomplete', 'mismatch') AND resolution_status NOT IN ('resolved', 'accepted')
    ORDER BY payout_time DESC NULLS LAST LIMIT p_limit
  LOOP
    PERFORM public.reconcile_payout(v_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Overview snapshot + local aggregate (monitoring only).
CREATE OR REPLACE FUNCTION public.record_income_overview(p_shop_id uuid, p_currency text, p_pending numeric, p_released numeric, p_payload jsonb, p_fetched_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_pending numeric; v_pending_n int; v_released numeric; v_row public.channel_income_overviews%ROWTYPE;
BEGIN
  SELECT COALESCE(sum(f.actual_shopee_income), 0), count(*) INTO v_pending, v_pending_n
  FROM public.channel_orders o
  LEFT JOIN public.order_financials f ON f.order_id = o.id
  WHERE o.shop_id = p_shop_id AND o.order_status = 'COMPLETED'
    AND NOT EXISTS (SELECT 1 FROM public.order_income_releases r WHERE r.order_id = o.id);
  SELECT COALESCE(sum(released_amount), 0) INTO v_released FROM public.order_income_releases WHERE shop_id = p_shop_id;

  INSERT INTO public.channel_income_overviews (shop_id, currency, pending_amount, released_amount, local_pending_amount, local_pending_orders,
    local_released_amount, pending_difference, released_difference, payload, fetched_at)
  VALUES (p_shop_id, upper(p_currency), p_pending, p_released, v_pending, v_pending_n, v_released,
    CASE WHEN p_pending IS NULL THEN NULL ELSE p_pending - v_pending END,
    CASE WHEN p_released IS NULL THEN NULL ELSE p_released - v_released END, COALESCE(p_payload, '{}'::jsonb), p_fetched_at)
  RETURNING * INTO v_row;

  DELETE FROM public.channel_income_overviews WHERE shop_id = p_shop_id AND fetched_at < p_fetched_at - interval '90 days';
  RETURN jsonb_build_object('pending_difference', v_row.pending_difference::text, 'released_difference', v_row.released_difference::text);
END;
$$;

-- Manual note / resolution (admin). Numbers are never touched.
CREATE OR REPLACE FUNCTION public.add_payout_reconciliation_note(p_payout_id uuid, p_note text, p_resolution_status text, p_resolution_reason text, p_by uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE b public.payout_batches%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO b FROM public.payout_batches WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy payout.' USING ERRCODE = 'PO010'; END IF;
  IF p_resolution_status IS NOT NULL AND p_resolution_status NOT IN ('open', 'investigating', 'resolved', 'accepted') THEN
    RAISE EXCEPTION 'Trạng thái xử lý không hợp lệ: %', p_resolution_status USING ERRCODE = 'PO011';
  END IF;
  IF p_resolution_status IN ('resolved', 'accepted') AND COALESCE(btrim(p_resolution_reason), '') = '' THEN
    RAISE EXCEPTION 'Cần lý do khi đóng chênh lệch.' USING ERRCODE = 'PO012';
  END IF;
  INSERT INTO public.payout_reconciliation_notes (payout_id, note, resolution_status, resolution_reason, difference_at_note, created_by)
  VALUES (p_payout_id, btrim(p_note), p_resolution_status, NULLIF(btrim(COALESCE(p_resolution_reason, '')), ''), b.difference_amount, p_by)
  RETURNING id INTO v_id;
  IF p_resolution_status IS NOT NULL AND p_resolution_status IS DISTINCT FROM b.resolution_status THEN
    UPDATE public.payout_batches
    SET resolution_status = p_resolution_status,
        resolution_reason = NULLIF(btrim(COALESCE(p_resolution_reason, '')), ''),
        resolved_at = CASE WHEN p_resolution_status IN ('resolved', 'accepted') THEN now() ELSE NULL END,
        resolved_by = CASE WHEN p_resolution_status IN ('resolved', 'accepted') THEN p_by ELSE NULL END
    WHERE id = p_payout_id;
  END IF;
  RETURN v_id;
END;
$$;


-- ============================================================
-- H. Triggers keeping reconciliation current
-- ============================================================

-- escrow / returns change actual_shopee_income → the release comparison follows
CREATE OR REPLACE FUNCTION public.order_financials_reconcile_release() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM public.reconcile_order_release(r.id) FROM public.order_income_releases r WHERE r.order_id = NEW.order_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER order_financials_reconcile_release
  AFTER INSERT OR UPDATE ON public.order_financials
  FOR EACH ROW
  WHEN (NEW.actual_shopee_income IS NOT NULL)
  EXECUTE FUNCTION public.order_financials_reconcile_release();

-- an order stored after its release / payout → linked automatically
CREATE OR REPLACE FUNCTION public.channel_orders_link_income() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE public.order_income_releases SET order_id = NEW.id
  WHERE shop_id = NEW.shop_id AND external_order_sn = NEW.external_order_sn AND order_id IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN PERFORM public.reconcile_order_release(v_id); END IF;
  PERFORM public.reconcile_payout(po.payout_id)
  FROM (SELECT DISTINCT po.payout_id FROM public.payout_orders po JOIN public.payout_batches b ON b.id = po.payout_id
        WHERE b.shop_id = NEW.shop_id AND po.external_order_sn = NEW.external_order_sn AND po.order_id IS NULL) po;
  RETURN NULL;
END;
$$;
CREATE TRIGGER channel_orders_link_income AFTER INSERT ON public.channel_orders
  FOR EACH ROW EXECUTE FUNCTION public.channel_orders_link_income();


-- ============================================================
-- I. Read models
-- ============================================================
CREATE OR REPLACE VIEW public.v_order_income_status WITH (security_invoker = true) AS
SELECT
  o.id                     AS order_id,
  o.shop_id,
  o.external_order_sn,
  o.order_status,
  o.currency,
  o.completed_at_channel,
  f.actual_shopee_income::text     AS expected_amount,
  r.id                     AS release_id,
  r.released_amount::text  AS released_amount,
  r.later_adjustment_amount::text AS later_adjustment_amount,
  r.difference_amount::text AS difference_amount,
  r.actual_payout_time,
  r.payment_method,
  r.release_source,
  r.income_synced_at,
  CASE
    WHEN r.id IS NOT NULL THEN r.release_status
    WHEN o.order_status = 'COMPLETED' THEN 'pending'
    ELSE 'not_available'
  END                      AS income_status,
  (r.id IS NULL AND o.order_status = 'COMPLETED' AND o.completed_at_channel IS NOT NULL
    AND o.completed_at_channel < now() - make_interval(days => st.release_stale_days)) AS release_stale,
  CASE WHEN r.actual_payout_time IS NOT NULL AND o.completed_at_channel IS NOT NULL
       THEN round(extract(epoch FROM (r.actual_payout_time - o.completed_at_channel)) / 86400.0, 1) END AS days_to_release,
  pb.id                    AS payout_id,
  pb.provider_payout_id
FROM public.channel_orders o
CROSS JOIN (SELECT release_stale_days FROM public.channel_sync_settings WHERE id) st
LEFT JOIN public.order_financials f ON f.order_id = o.id
LEFT JOIN public.order_income_releases r ON r.order_id = o.id
LEFT JOIN LATERAL (
  SELECT b.id, b.provider_payout_id FROM public.payout_orders po JOIN public.payout_batches b ON b.id = po.payout_id
  WHERE po.order_id = o.id ORDER BY b.payout_time DESC NULLS LAST LIMIT 1
) pb ON true;

CREATE OR REPLACE VIEW public.v_payout_overview WITH (security_invoker = true) AS
SELECT
  b.id, b.shop_id, s.shop_name, b.provider_payout_id, b.payout_source, b.payout_status,
  b.payout_currency AS currency, b.payout_amount::text AS payout_amount, b.payout_time, b.payment_method, b.bank_reference,
  b.orders_released_total::text AS orders_released_total, b.adjustments_total::text AS adjustments_total,
  b.opening_balance::text AS opening_balance, b.closing_balance::text AS closing_balance,
  b.expected_amount::text AS expected_amount, b.difference_amount::text AS difference_amount,
  b.order_count, b.missing_order_count, b.adjustment_count,
  b.reconciliation_status, b.incomplete_reason, b.reconciled_at, b.last_provider_amount::text AS last_provider_amount,
  b.resolution_status, b.resolution_reason, b.resolved_at, b.resolved_by, b.synced_at
FROM public.payout_batches b JOIN public.shops s ON s.id = b.shop_id;

-- Finance operational metrics (cash, NOT profit). Day boundaries in VN time.
CREATE OR REPLACE FUNCTION public.get_shopee_cashflow_summary(p_shop_id uuid DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH s AS (
    SELECT * FROM public.v_order_income_status v WHERE p_shop_id IS NULL OR v.shop_id = p_shop_id
  ), today AS (
    SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS d
  )
  SELECT jsonb_build_object(
    'pending_orders',        (SELECT count(*) FROM s WHERE income_status = 'pending'),
    'pending_amount',        (SELECT COALESCE(sum(expected_amount::numeric), 0)::text FROM s WHERE income_status = 'pending'),
    'pending_without_amount',(SELECT count(*) FROM s WHERE income_status = 'pending' AND expected_amount IS NULL),
    'stale_orders',          (SELECT count(*) FROM s WHERE release_stale),
    'release_mismatch_orders',(SELECT count(*) FROM s WHERE income_status = 'mismatch'),
    'released_today_amount', (SELECT COALESCE(sum(r.released_amount), 0)::text FROM public.order_income_releases r, today
                              WHERE (p_shop_id IS NULL OR r.shop_id = p_shop_id) AND (r.actual_payout_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = today.d),
    'released_today_orders', (SELECT count(*) FROM public.order_income_releases r, today
                              WHERE (p_shop_id IS NULL OR r.shop_id = p_shop_id) AND (r.actual_payout_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = today.d),
    'payouts_unreconciled',  (SELECT count(*) FROM public.payout_batches b WHERE (p_shop_id IS NULL OR b.shop_id = p_shop_id) AND b.reconciliation_status IN ('pending', 'incomplete')),
    'payouts_mismatch',      (SELECT count(*) FROM public.payout_batches b WHERE (p_shop_id IS NULL OR b.shop_id = p_shop_id) AND b.reconciliation_status = 'mismatch' AND b.resolution_status IN ('open', 'investigating')),
    'payout_period_amount',  (SELECT COALESCE(sum(b.payout_amount), 0)::text FROM public.payout_batches b
                              WHERE (p_shop_id IS NULL OR b.shop_id = p_shop_id) AND b.payout_status = 'completed'
                                AND (p_from IS NULL OR (b.payout_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= p_from)
                                AND (p_to IS NULL OR (b.payout_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= p_to)),
    'payout_period_count',   (SELECT count(*) FROM public.payout_batches b
                              WHERE (p_shop_id IS NULL OR b.shop_id = p_shop_id) AND b.payout_status = 'completed'
                                AND (p_from IS NULL OR (b.payout_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= p_from)
                                AND (p_to IS NULL OR (b.payout_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= p_to))
  )
$$;


-- ============================================================
-- J. Privileges (cloud: explicit grants, always)
-- ============================================================
DO $$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_income_releases', 'channel_income_overviews', 'channel_wallet_transactions', 'payout_reconciliation_notes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY active_users_select ON public.%I FOR SELECT TO authenticated USING (public.is_active_user())', t);
  END LOOP;
  -- raw wallet payloads: server only
  EXECUTE 'REVOKE SELECT ON public.channel_wallet_transactions FROM authenticated';

  FOREACH f IN ARRAY ARRAY[
    'reconcile_order_release(uuid)',
    'apply_income_releases(uuid, text, jsonb, timestamptz)',
    'reconcile_payout(uuid)',
    'apply_payout(uuid, text, jsonb, jsonb, jsonb, timestamptz)',
    'apply_wallet_transactions(uuid, jsonb)',
    'build_wallet_payouts(uuid, integer)',
    'reconcile_open_payouts(uuid, integer)',
    'record_income_overview(uuid, text, numeric, numeric, jsonb, timestamptz)',
    'add_payout_reconciliation_note(uuid, text, text, text, uuid)',
    'get_shopee_cashflow_summary(uuid, date, date)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'money_match_tolerance(text)', 'channel_orders_set_completed_at()', 'guard_payout_amount()',
    'order_financials_reconcile_release()', 'channel_orders_link_income()'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
GRANT SELECT ON public.v_order_income_status, public.v_payout_overview TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
