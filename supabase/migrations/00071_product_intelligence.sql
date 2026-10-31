-- ============================================================
-- PRODUCT-ANALYTICS-3: unified product intelligence + deterministic signal layer.
--
-- SQL OWNS TRUTH: every metric, delta, coverage flag, signal, health label and
-- attention priority is computed here; the app only renders / labels it.
-- Thresholds are NOT in this file: they arrive as p_cfg (jsonb) built from
-- src/lib/product-analytics/config.ts (PRODUCT_INTELLIGENCE_CONFIG) — one place.
--
-- Signals are FACTUAL observations ("SALES_DOWN −32 %"), never causes. There is
-- deliberately no rule of the kind "sales down and ads down → cause = ads".
-- Health is descriptive and explainable (rule code + top signals); priority is
-- a transparent product of signal points × business scale × data confidence.
--
-- Broad Ads GMV is Shopee attribution: nothing here subtracts it from sales
-- (no "organic" remainder) or calls it a share of sales.
--
-- Read-only: no function in this file writes anything. Zero Shopee calls.
-- ============================================================


-- ------------------------------------------------------------
-- A. small pure helpers
-- ------------------------------------------------------------

-- accent-insensitive search key (Vietnamese): NFD, strip combining marks, đ → d, lower, single spaces
CREATE FUNCTION public.pa_fold(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT btrim(regexp_replace(translate(lower(regexp_replace(normalize(COALESCE(p, ''), NFD), '[̀-ͯ]', '', 'g')), 'đ', 'd'), '\s+', ' ', 'g'));
$$;

CREATE FUNCTION public.pa_conf_down(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE p WHEN 'HIGH' THEN 'MEDIUM' ELSE 'LOW' END;
$$;

CREATE FUNCTION public.pa_conf_rank(p text)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE p WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END;
$$;

CREATE FUNCTION public.pa_jappend(p_arr jsonb, p_el jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE WHEN p_el IS NULL THEN p_arr ELSE p_arr || jsonb_build_array(p_el) END;
$$;

CREATE FUNCTION public.pa_pct(p_cur numeric, p_prev numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE WHEN p_cur IS NULL OR p_prev IS NULL OR p_prev = 0 THEN NULL ELSE round((p_cur - p_prev) / p_prev * 100, 2) END;
$$;

-- ONE factual movement signal, or NULL.
--   * no signal unless the previous value is a real base (≥ p_min_base, > 0)
--   * |Δ%| < p_minor → no signal (or the "flat" type, e.g. SALES_STABLE)
--   * polarity = business meaning of the direction: p_up_polarity is the meaning of UP
--     ('positive' | 'negative' | 'neutral'); DOWN is the opposite (neutral stays neutral)
--   * severity: favourable / neutral → INFO; unfavourable → WARNING only when the move is
--     major AND the product's business scale is large enough, otherwise NOTICE
CREATE FUNCTION public.pa_signal(
  p_up text, p_down text, p_flat text, p_family text, p_metric text,
  p_cur numeric, p_prev numeric, p_min_base numeric, p_minor numeric, p_major numeric,
  p_up_polarity text, p_scale_ok boolean, p_conf text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
DECLARE
  v_pct numeric;
  v_dir text;
  v_pol text;
  v_sev text;
BEGIN
  IF p_cur IS NULL OR p_prev IS NULL OR p_prev <= 0 OR p_prev < p_min_base THEN RETURN NULL; END IF;
  v_pct := round((p_cur - p_prev) / p_prev * 100, 1);
  IF abs(v_pct) < p_minor THEN
    IF p_flat IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('type', p_flat, 'family', p_family, 'metric', p_metric, 'direction', 'flat', 'polarity', 'neutral',
                              'severity', 'INFO', 'confidence', p_conf, 'current', p_cur, 'previous', p_prev,
                              'abs_change', p_cur - p_prev, 'change_pct', v_pct);
  END IF;
  v_dir := CASE WHEN v_pct > 0 THEN 'up' ELSE 'down' END;
  v_pol := CASE WHEN v_dir = 'up' THEN p_up_polarity
                WHEN p_up_polarity = 'positive' THEN 'negative'
                WHEN p_up_polarity = 'negative' THEN 'positive'
                ELSE 'neutral' END;
  v_sev := CASE WHEN v_pol <> 'negative' THEN 'INFO'
                WHEN abs(v_pct) >= p_major AND p_scale_ok THEN 'WARNING'
                ELSE 'NOTICE' END;
  RETURN jsonb_build_object('type', CASE WHEN v_dir = 'up' THEN p_up ELSE p_down END, 'family', p_family, 'metric', p_metric,
                            'direction', v_dir, 'polarity', v_pol, 'severity', v_sev, 'confidence', p_conf,
                            'current', p_cur, 'previous', p_prev, 'abs_change', p_cur - p_prev, 'change_pct', v_pct);
END;
$$;


-- ------------------------------------------------------------
-- B. the signal / health / priority engine — PURE (numbers in, jsonb out)
--
--   p_m   {gmv1, gmv0, orders1, orders0, units1, units0, spend1, spend0, impressions1, impressions0,
--          clicks1, clicks0, broad_order1, broad_order0, broad_gmv1, broad_gmv0, campaigns}
--         (sales values NULL = no sales data at all — never treated as 0)
--   p_ctx {sales_state, covered_from, sales_current_complete, sales_previous_complete, sales_comparable,
--          ads_comparable, same_time_ok, partial_today, hour_cutoff, sales_stale, ads_stale, ads_missing,
--          has_snapshot, sales_age_minutes, ads_age_minutes}
--   p_cfg thresholds (config.ts → intelligenceConfigJson())
-- ------------------------------------------------------------
CREATE FUNCTION public.pa_intelligence_eval(p_m jsonb, p_ctx jsonb, p_cfg jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
DECLARE
  k_required constant text[] := ARRAY['change_pct_minor', 'change_pct_major', 'volume_pct_minor', 'volume_pct_major', 'min_sales_gmv', 'min_orders',
    'min_units', 'min_ads_spend', 'min_clicks', 'min_impressions', 'min_ratio_clicks', 'scale_large_gmv', 'scale_large_spend', 'high_conf_orders',
    'high_conf_clicks', 'priority_scale_unit', 'priority_warning_points', 'priority_notice_points', 'priority_signal_cap', 'priority_high',
    'priority_medium', 'attention_min_score'];
  g1 numeric := (p_m->>'gmv1')::numeric;            g0 numeric := (p_m->>'gmv0')::numeric;
  o1 numeric := (p_m->>'orders1')::numeric;         o0 numeric := (p_m->>'orders0')::numeric;
  u1 numeric := (p_m->>'units1')::numeric;          u0 numeric := (p_m->>'units0')::numeric;
  e1 numeric := COALESCE((p_m->>'spend1')::numeric, 0);        e0 numeric := COALESCE((p_m->>'spend0')::numeric, 0);
  i1 numeric := COALESCE((p_m->>'impressions1')::numeric, 0);  i0 numeric := COALESCE((p_m->>'impressions0')::numeric, 0);
  c1 numeric := COALESCE((p_m->>'clicks1')::numeric, 0);       c0 numeric := COALESCE((p_m->>'clicks0')::numeric, 0);
  bo1 numeric := COALESCE((p_m->>'broad_order1')::numeric, 0); bo0 numeric := COALESCE((p_m->>'broad_order0')::numeric, 0);
  bg1 numeric := COALESCE((p_m->>'broad_gmv1')::numeric, 0);   bg0 numeric := COALESCE((p_m->>'broad_gmv0')::numeric, 0);
  v_campaigns integer := COALESCE((p_m->>'campaigns')::integer, 0);
  v_state text := COALESCE(p_ctx->>'sales_state', 'no_data');
  v_sales_ok boolean := COALESCE((p_ctx->>'sales_comparable')::boolean, false);
  v_ads_ok boolean;
  v_partial boolean := COALESCE((p_ctx->>'partial_today')::boolean, false);
  v_sales_stale boolean := COALESCE((p_ctx->>'sales_stale')::boolean, false);
  v_ads_stale boolean;
  v_minor numeric; v_major numeric; v_vminor numeric; v_vmajor numeric;
  v_sales_scale boolean; v_ads_scale boolean;
  v_sconf text := 'HIGH'; v_vconf text := 'HIGH'; v_rconf text := 'HIGH';
  v_sigs jsonb := '[]'::jsonb;
  v_dq jsonb := '[]'::jsonb;
  v_top jsonb;
  v_neg_warn integer; v_neg_notice integer;
  v_sales_down_warn boolean; v_sales_down_sharp boolean; v_eff_down boolean; v_sales_up boolean;
  v_usable_ads boolean;
  v_label text; v_rule text; v_basis text; v_hconf text;
  v_signal_points numeric; v_scale_points numeric; v_score numeric; v_business numeric;
  v_e jsonb; v_t text; k integer; n integer; v_best integer; v_min_conf integer;
  v_keys numeric[] := ARRAY[]::numeric[];
  v_idx integer[] := ARRAY[]::integer[];
BEGIN
  IF p_cfg IS NULL OR NOT (p_cfg ?& k_required) THEN
    RAISE EXCEPTION 'pa_intelligence_eval: p_cfg is missing keys (expected %)', k_required;
  END IF;
  v_minor := (p_cfg->>'change_pct_minor')::numeric;  v_major := (p_cfg->>'change_pct_major')::numeric;
  v_vminor := (p_cfg->>'volume_pct_minor')::numeric; v_vmajor := (p_cfg->>'volume_pct_major')::numeric;
  v_ads_ok := v_campaigns > 0 AND COALESCE((p_ctx->>'ads_comparable')::boolean, false);
  v_ads_stale := v_campaigns > 0 AND COALESCE((p_ctx->>'ads_stale')::boolean, false);
  v_sales_scale := GREATEST(COALESCE(g1, 0), COALESCE(g0, 0)) >= (p_cfg->>'scale_large_gmv')::numeric;
  v_ads_scale := GREATEST(e1, e0) >= (p_cfg->>'scale_large_spend')::numeric;

  -- confidence: sample size, freshness, partial day (semantic confidence of every metric used here is HIGH)
  IF COALESCE(o1, 0) + COALESCE(o0, 0) < (p_cfg->>'high_conf_orders')::numeric THEN v_sconf := 'MEDIUM'; END IF;
  IF LEAST(c1, c0) < (p_cfg->>'high_conf_clicks')::numeric THEN v_rconf := 'MEDIUM'; END IF;
  IF v_sales_stale THEN v_sconf := public.pa_conf_down(v_sconf); END IF;
  IF v_ads_stale THEN v_vconf := public.pa_conf_down(v_vconf); v_rconf := public.pa_conf_down(v_rconf); END IF;
  IF v_partial THEN
    v_sconf := public.pa_conf_down(v_sconf); v_vconf := public.pa_conf_down(v_vconf); v_rconf := public.pa_conf_down(v_rconf);
  END IF;

  -- sales signals: ONLY when both periods are fully covered (missing data is not a decline)
  IF v_sales_ok THEN
    v_sigs := public.pa_jappend(v_sigs, public.pa_signal('SALES_UP', 'SALES_DOWN', 'SALES_STABLE', 'sales', 'sales_gmv', g1, g0,
      (p_cfg->>'min_sales_gmv')::numeric, v_minor, v_major, 'positive', v_sales_scale, v_sconf));
    v_sigs := public.pa_jappend(v_sigs, public.pa_signal('ORDERS_UP', 'ORDERS_DOWN', NULL, 'sales', 'orders', o1, o0,
      (p_cfg->>'min_orders')::numeric, v_minor, v_major, 'positive', v_sales_scale, v_sconf));
    v_sigs := public.pa_jappend(v_sigs, public.pa_signal('UNITS_UP', 'UNITS_DOWN', NULL, 'sales', 'units', u1, u0,
      (p_cfg->>'min_units')::numeric, v_minor, v_major, 'positive', v_sales_scale, v_sconf));
  END IF;

  -- Ads signals (single-item campaigns only); ratios = ratio of sums, need a real base in BOTH periods
  IF v_ads_ok THEN
    v_sigs := public.pa_jappend(v_sigs, public.pa_signal('ADS_SPEND_UP', 'ADS_SPEND_DOWN', NULL, 'ads', 'ads_spend', e1, e0,
      (p_cfg->>'min_ads_spend')::numeric, v_vminor, v_vmajor, 'neutral', v_ads_scale, v_vconf));
    v_sigs := public.pa_jappend(v_sigs, public.pa_signal('ADS_IMPRESSIONS_UP', 'ADS_IMPRESSIONS_DOWN', NULL, 'ads', 'ads_impressions', i1, i0,
      (p_cfg->>'min_impressions')::numeric, v_vminor, v_vmajor, 'positive', v_ads_scale, v_vconf));
    v_sigs := public.pa_jappend(v_sigs, public.pa_signal('ADS_CLICKS_UP', 'ADS_CLICKS_DOWN', NULL, 'ads', 'ads_clicks', c1, c0,
      (p_cfg->>'min_clicks')::numeric, v_vminor, v_vmajor, 'positive', v_ads_scale, v_vconf));
    IF LEAST(e1, e0) >= (p_cfg->>'min_ads_spend')::numeric THEN
      v_sigs := public.pa_jappend(v_sigs, public.pa_signal('ADS_ROAS_UP', 'ADS_ROAS_DOWN', NULL, 'ads', 'ads_broad_roas',
        round(public.pa_ratio(bg1, e1), 4), round(public.pa_ratio(bg0, e0), 4), 0, v_minor, v_major, 'positive', v_ads_scale, v_rconf));
      IF LEAST(c1, c0) >= (p_cfg->>'min_clicks')::numeric THEN
        -- CPC up is unfavourable, CPC down favourable
        v_sigs := public.pa_jappend(v_sigs, public.pa_signal('ADS_CPC_UP', 'ADS_CPC_DOWN', NULL, 'ads', 'ads_cpc',
          round(public.pa_ratio(e1, c1), 2), round(public.pa_ratio(e0, c0), 2), 0, v_minor, v_major, 'negative', v_ads_scale, v_rconf));
      END IF;
    END IF;
    IF LEAST(c1, c0) >= (p_cfg->>'min_ratio_clicks')::numeric THEN
      v_sigs := public.pa_jappend(v_sigs, public.pa_signal('ADS_CVR_UP', 'ADS_CVR_DOWN', NULL, 'ads', 'ads_broad_cvr',
        round(public.pa_ratio(bo1, c1), 6), round(public.pa_ratio(bo0, c0), 6), 0, v_minor, v_major, 'positive', v_ads_scale, v_rconf));
    END IF;
  END IF;

  -- data-quality signals (not performance problems)
  IF v_state = 'no_data' THEN
    v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'SALES_DATA_MISSING', 'family', 'data_quality', 'scope', 'sales', 'severity', 'INFO'));
  ELSIF NOT COALESCE((p_ctx->>'sales_current_complete')::boolean, false) THEN
    v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'SALES_INCOMPLETE', 'family', 'data_quality', 'scope', 'sales', 'severity', 'INFO',
      'detail', jsonb_build_object('covered_from', p_ctx->'covered_from', 'state', v_state)));
  ELSIF NOT COALESCE((p_ctx->>'sales_previous_complete')::boolean, false) THEN
    v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'COMPARISON_UNAVAILABLE', 'family', 'data_quality', 'scope', 'sales', 'severity', 'INFO',
      'detail', jsonb_build_object('reason', 'previous_period_not_covered', 'covered_from', p_ctx->'covered_from')));
  END IF;
  IF v_partial THEN
    v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'PARTIAL_TODAY', 'family', 'data_quality', 'scope', 'period', 'severity', 'INFO',
      'detail', jsonb_build_object('hour_cutoff', p_ctx->'hour_cutoff')));
    IF NOT COALESCE((p_ctx->>'same_time_ok')::boolean, false) THEN
      v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'COMPARISON_UNAVAILABLE', 'family', 'data_quality', 'scope', 'period', 'severity', 'INFO',
        'detail', jsonb_build_object('reason', 'partial_today_no_completed_hour')));
    ELSIF v_campaigns > 0 AND NOT COALESCE((p_ctx->>'ads_comparable')::boolean, false) THEN
      v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'COMPARISON_UNAVAILABLE', 'family', 'data_quality', 'scope', 'ads', 'severity', 'INFO',
        'detail', jsonb_build_object('reason', 'no_previous_hourly_ads')));
    END IF;
  END IF;
  IF v_sales_stale AND v_state <> 'no_data' THEN
    v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'DATA_STALE', 'family', 'data_quality', 'scope', 'sales', 'severity', 'INFO',
      'detail', jsonb_build_object('age_minutes', p_ctx->'sales_age_minutes')));
  END IF;
  IF v_campaigns > 0 AND COALESCE((p_ctx->>'ads_missing')::boolean, false) THEN
    v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'ADS_DATA_MISSING', 'family', 'data_quality', 'scope', 'ads', 'severity', 'INFO'));
  ELSIF v_ads_stale THEN
    v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'DATA_STALE', 'family', 'data_quality', 'scope', 'ads', 'severity', 'INFO',
      'detail', jsonb_build_object('age_minutes', p_ctx->'ads_age_minutes')));
  END IF;
  IF COALESCE((p_ctx->>'has_snapshot')::boolean, false) THEN
    v_dq := public.pa_jappend(v_dq, jsonb_build_object('type', 'SNAPSHOT_SEMANTICS_UNKNOWN', 'family', 'data_quality', 'scope', 'snapshot', 'severity', 'INFO'));
  END IF;

  -- signal composition (descriptive only) — in-memory loops over ≤ 12 elements (no SPI query per row)
  v_neg_warn := 0; v_neg_notice := 0;
  v_sales_down_warn := false; v_sales_down_sharp := false; v_eff_down := false; v_sales_up := false;
  FOR k IN 0 .. jsonb_array_length(v_sigs) - 1 LOOP
    v_e := v_sigs -> k;
    v_t := v_e->>'type';
    IF v_e->>'polarity' = 'negative' THEN
      IF v_e->>'severity' = 'WARNING' THEN v_neg_warn := v_neg_warn + 1; ELSE v_neg_notice := v_neg_notice + 1; END IF;
    END IF;
    IF v_t IN ('SALES_DOWN', 'ORDERS_DOWN') AND v_e->>'severity' = 'WARNING' THEN v_sales_down_warn := true; END IF;
    IF v_t = 'SALES_DOWN' AND v_e->>'severity' = 'WARNING' AND (v_e->>'change_pct')::numeric <= -2 * v_major THEN v_sales_down_sharp := true; END IF;
    IF v_t IN ('ADS_ROAS_DOWN', 'ADS_CVR_DOWN', 'ADS_CPC_UP') THEN v_eff_down := true; END IF;
    IF v_t IN ('SALES_UP', 'ORDERS_UP') THEN v_sales_up := true; END IF;
    -- ranking key: unfavourable first, then severity, then size of the move (|Δ%| capped)
    IF v_e->>'direction' <> 'flat' THEN
      v_keys := v_keys || ((CASE WHEN v_e->>'polarity' = 'negative' THEN 1e7 ELSE 0 END)
                           + (CASE v_e->>'severity' WHEN 'WARNING' THEN 3e6 WHEN 'NOTICE' THEN 2e6 ELSE 1e6 END)
                           + LEAST(abs((v_e->>'change_pct')::numeric), 999999));
      v_idx := v_idx || k;
    END IF;
  END LOOP;

  -- top signals (≤ 3) + the weakest confidence among them
  v_top := '[]'::jsonb;
  v_min_conf := 4;
  FOR n IN 1 .. LEAST(3, COALESCE(array_length(v_keys, 1), 0)) LOOP
    v_best := 0;
    FOR k IN 1 .. array_length(v_keys, 1) LOOP
      IF v_keys[k] IS NOT NULL AND (v_best = 0 OR v_keys[k] > v_keys[v_best]) THEN v_best := k; END IF;
    END LOOP;
    v_e := v_sigs -> v_idx[v_best];
    v_top := v_top || jsonb_build_array(v_e);
    v_min_conf := LEAST(v_min_conf, public.pa_conf_rank(v_e->>'confidence'));
    v_keys[v_best] := NULL;
  END LOOP;

  v_usable_ads := v_ads_ok AND GREATEST(e1, e0) >= (p_cfg->>'min_ads_spend')::numeric;
  v_basis := CASE WHEN v_sales_ok AND v_usable_ads THEN 'sales_and_ads' WHEN v_sales_ok THEN 'sales' WHEN v_usable_ads THEN 'ads' ELSE 'none' END;

  IF NOT v_sales_ok AND NOT v_usable_ads THEN
    v_label := 'INSUFFICIENT_DATA'; v_rule := 'no_comparable_data';
  ELSIF GREATEST(COALESCE(g1, 0), COALESCE(g0, 0)) < (p_cfg->>'min_sales_gmv')::numeric AND GREATEST(e1, e0) < (p_cfg->>'min_ads_spend')::numeric THEN
    v_label := 'INSUFFICIENT_DATA'; v_rule := 'low_volume';
  ELSIF v_sales_down_warn AND v_eff_down THEN
    v_label := 'WEAK'; v_rule := 'sales_and_efficiency_down';
  ELSIF v_sales_down_sharp THEN
    v_label := 'WEAK'; v_rule := 'sales_down_sharply';
  ELSIF v_neg_warn >= 1 THEN
    v_label := 'WATCH'; v_rule := 'warning_signals';
  ELSIF v_neg_notice >= 2 THEN
    v_label := 'WATCH'; v_rule := 'multiple_notices';
  ELSIF v_sales_up THEN
    v_label := 'GOOD'; v_rule := 'sales_growing';
  ELSE
    v_label := 'STABLE'; v_rule := 'no_significant_change';
  END IF;

  -- health confidence: LOW without a sales comparison; otherwise the weakest of the top signals
  IF NOT v_sales_ok THEN
    v_hconf := 'LOW';
  ELSE
    v_hconf := CASE v_min_conf WHEN 1 THEN 'LOW' WHEN 2 THEN 'MEDIUM' WHEN 3 THEN 'HIGH' ELSE v_sconf END;
  END IF;

  -- attention priority = unfavourable-signal points × (1 + business scale / 10) × confidence
  v_signal_points := LEAST((p_cfg->>'priority_signal_cap')::numeric,
                           v_neg_warn * (p_cfg->>'priority_warning_points')::numeric + v_neg_notice * (p_cfg->>'priority_notice_points')::numeric);
  v_business := GREATEST(COALESCE(g1, 0), COALESCE(g0, 0)) + GREATEST(e1, e0);
  v_scale_points := GREATEST(0, round(10 * log(10, 1 + v_business / (p_cfg->>'priority_scale_unit')::numeric)));
  v_score := round(v_signal_points * (1 + v_scale_points / 10.0) * CASE v_hconf WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 0.75 ELSE 0.5 END);

  RETURN jsonb_build_object(
    'signals', v_sigs,
    'data_quality', v_dq,
    'top_signals', v_top,
    'health', jsonb_build_object(
      'label', v_label,
      'severity', CASE v_label WHEN 'WEAK' THEN 'WARNING' WHEN 'WATCH' THEN 'NOTICE' ELSE 'INFO' END,
      'confidence', v_hconf,
      'rule', v_rule,
      'basis', v_basis,
      'negative_warnings', v_neg_warn,
      'negative_notices', v_neg_notice),
    'priority', jsonb_build_object(
      'score', v_score,
      'level', CASE WHEN v_score >= (p_cfg->>'priority_high')::numeric THEN 'HIGH'
                    WHEN v_score >= (p_cfg->>'priority_medium')::numeric THEN 'MEDIUM'
                    WHEN v_score > 0 THEN 'LOW' ELSE 'NONE' END,
      'signal_points', v_signal_points,
      'scale_points', v_scale_points,
      'business_vnd', v_business,
      'confidence', v_hconf),
    'needs_attention', v_label IN ('WATCH', 'WEAK') AND v_score >= (p_cfg->>'attention_min_score')::numeric
  );
END;
$$;


-- ------------------------------------------------------------
-- C. per-shop context: sales coverage + freshness (mirrors src/lib/product-analytics/coverage.ts)
--    covered_from = VN date(sales_backfill_done_at) − backfill_days
-- ------------------------------------------------------------
CREATE FUNCTION public.product_intelligence_shops(p_shop_ids uuid[], p_from date, p_prev_from date, p_cfg jsonb)
RETURNS TABLE (shop_id uuid, sales_enabled boolean, sales_state text, covered_from date, current_complete boolean, previous_complete boolean,
               sales_backfill_done_at timestamptz, sales_last_success_at timestamptz, sales_age_minutes integer, sales_stale boolean,
               ads_today_at timestamptz, ads_age_minutes integer, ads_stale boolean)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH s AS (
    SELECT u.id AS sid, COALESCE(x.sales_sync_enabled, false) AS enabled, x.sales_backfill_done_at AS bf, st.last_success_at AS sales_last, af.campaign_today_at AS ads_today
    FROM unnest(p_shop_ids) AS u(id)
    LEFT JOIN public.product_analytics_shop_settings x ON x.shop_id = u.id
    LEFT JOIN public.channel_sync_states st ON st.shop_id = u.id AND st.sync_type = 'product_sales_facts_read'
    LEFT JOIN LATERAL public.ads_sync_freshness(ARRAY[u.id]) af ON true
  ), c AS (
    SELECT s.*,
           CASE WHEN s.sales_last IS NULL AND s.bf IS NULL THEN 'no_data' WHEN s.bf IS NULL THEN 'not_backfilled' ELSE 'covered' END AS state,
           CASE WHEN s.bf IS NULL THEN NULL ELSE (s.bf AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - (p_cfg->>'backfill_days')::integer END AS cfrom,
           round(extract(epoch FROM now() - s.sales_last) / 60)::integer AS sales_age,
           round(extract(epoch FROM now() - s.ads_today) / 60)::integer AS ads_age
    FROM s
  )
  SELECT c.sid, c.enabled, c.state, c.cfrom,
         c.state = 'covered' AND p_from >= c.cfrom,
         c.state = 'covered' AND p_prev_from >= c.cfrom,
         c.bf, c.sales_last, c.sales_age,
         c.sales_age IS NULL OR c.sales_age > (p_cfg->>'sales_stale_minutes')::numeric,
         c.ads_today, c.ads_age,
         c.ads_age IS NULL OR c.ads_age > (p_cfg->>'ads_stale_minutes')::numeric
  FROM c;
$$;


-- ------------------------------------------------------------
-- D. unified product intelligence rows (one row per product with sales / Ads in either
--    period or a current single-item campaign; p_item_id = that one product, always returned)
--    p_hour_cutoff (today): sales = orders created before HH:00 VN on each day; Ads = hourly
--    rows with hour < HH. p_partial_today without a cutoff (custom range incl. today) → no comparison.
-- ------------------------------------------------------------
CREATE FUNCTION public.product_intelligence_rows(
  p_shop_ids uuid[], p_from date, p_to date, p_prev_from date, p_prev_to date,
  p_hour_cutoff integer, p_partial_today boolean, p_cfg jsonb, p_item_id text DEFAULT NULL)
RETURNS TABLE (id uuid, shop_id uuid, item_id text, name text, sku text, image_url text, status text,
               campaigns integer, shared_campaigns integer,
               gmv numeric, orders bigint, units bigint, prev_gmv numeric, prev_orders bigint, prev_units bigint, gmv_pct numeric, orders_pct numeric,
               spend numeric, prev_spend numeric, spend_pct numeric, impressions bigint, clicks bigint,
               broad_order bigint, direct_order bigint, broad_gmv numeric, direct_gmv numeric,
               broad_roas numeric, prev_broad_roas numeric, roas_pct numeric,
               sales_state text, covered_from date, sales_exact boolean, sales_comparable boolean, ads_comparable boolean,
               intel jsonb)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH cv AS (
    SELECT * FROM public.product_intelligence_shops(p_shop_ids, p_from, p_prev_from, p_cfg)
  ),
  sales AS (
    SELECT f.shop_id AS sid, f.provider_item_id AS iid,
           count(DISTINCT f.provider_order_id) FILTER (WHERE f.valid_quantity > 0 AND f.report_date BETWEEN p_from AND p_to) AS o1,
           COALESCE(sum(f.valid_quantity) FILTER (WHERE f.report_date BETWEEN p_from AND p_to), 0)::bigint AS u1,
           COALESCE(sum(f.valid_amount) FILTER (WHERE f.report_date BETWEEN p_from AND p_to), 0)::numeric AS g1,
           count(DISTINCT f.provider_order_id) FILTER (WHERE f.valid_quantity > 0 AND f.report_date BETWEEN p_prev_from AND p_prev_to) AS o0,
           COALESCE(sum(f.valid_quantity) FILTER (WHERE f.report_date BETWEEN p_prev_from AND p_prev_to), 0)::bigint AS u0,
           COALESCE(sum(f.valid_amount) FILTER (WHERE f.report_date BETWEEN p_prev_from AND p_prev_to), 0)::numeric AS g0
    FROM public.shopee_product_sales_facts f
    WHERE f.shop_id = ANY (p_shop_ids) AND (p_item_id IS NULL OR f.provider_item_id = p_item_id)
      AND f.report_date BETWEEN LEAST(p_from, p_prev_from) AND GREATEST(p_to, p_prev_to)
      AND (p_hour_cutoff IS NULL OR extract(hour FROM f.order_created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') < p_hour_cutoff)
    GROUP BY 1, 2
  ),
  links AS (
    SELECT l.shop_id AS sid, l.provider_item_id AS iid, l.campaign_id, l.single_item
    FROM public.shopee_product_campaign_links l
    WHERE l.shop_id = ANY (p_shop_ids) AND (p_item_id IS NULL OR l.provider_item_id = p_item_id)
  ),
  perf AS (
    SELECT d.campaign_id, d.report_date, d.expense, d.impression, d.clicks, d.direct_order, d.broad_order, d.direct_gmv, d.broad_gmv
    FROM public.shopee_ads_campaign_daily_performance d
    WHERE p_hour_cutoff IS NULL AND d.shop_id = ANY (p_shop_ids) AND d.report_date BETWEEN LEAST(p_from, p_prev_from) AND GREATEST(p_to, p_prev_to)
    UNION ALL
    SELECT h.campaign_id, h.report_date, h.expense, h.impression, h.clicks, h.direct_order, h.broad_order, h.direct_gmv, h.broad_gmv
    FROM public.shopee_ads_campaign_hourly_performance h
    WHERE p_hour_cutoff IS NOT NULL AND h.shop_id = ANY (p_shop_ids) AND h.report_date BETWEEN LEAST(p_from, p_prev_from) AND GREATEST(p_to, p_prev_to)
      AND h.report_hour < p_hour_cutoff
  ),
  ads AS (
    SELECT l.sid, l.iid,
           COALESCE(sum(x.expense) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0) AS e1,
           COALESCE(sum(x.impression) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0)::bigint AS i1,
           COALESCE(sum(x.clicks) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0)::bigint AS c1,
           COALESCE(sum(x.direct_order) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0)::bigint AS dor1,
           COALESCE(sum(x.broad_order) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0)::bigint AS bo1,
           COALESCE(sum(x.direct_gmv) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0) AS dg1,
           COALESCE(sum(x.broad_gmv) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0) AS bg1,
           COALESCE(sum(x.expense) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS e0,
           COALESCE(sum(x.impression) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to), 0)::bigint AS i0,
           COALESCE(sum(x.clicks) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to), 0)::bigint AS c0,
           COALESCE(sum(x.broad_order) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to), 0)::bigint AS bo0,
           COALESCE(sum(x.broad_gmv) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS bg0,
           count(*) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to) AS n0
    FROM links l JOIN perf x ON x.campaign_id = l.campaign_id
    WHERE l.single_item
    GROUP BY 1, 2
  ),
  camp AS (
    SELECT sid, iid, count(*) FILTER (WHERE single_item) AS single_n, count(*) FILTER (WHERE NOT single_item) AS shared_n FROM links GROUP BY 1, 2
  ),
  snap AS (
    SELECT DISTINCT e.shop_id AS sid, e.provider_item_id AS iid FROM public.shopee_product_extra_snapshots e
    WHERE e.shop_id = ANY (p_shop_ids) AND (p_item_id IS NULL OR e.provider_item_id = p_item_id)
  ),
  b AS (
    SELECT p.id, p.shop_id, p.provider_item_id, p.name, p.sku, p.image_url, p.provider_status,
           COALESCE(c.single_n, 0)::integer AS campaigns, COALESCE(c.shared_n, 0)::integer AS shared,
           cv.sales_state, cv.covered_from, cv.current_complete, cv.previous_complete, cv.sales_stale, cv.ads_stale,
           cv.ads_today_at IS NULL AS ads_missing, cv.sales_age_minutes, cv.ads_age_minutes,
           (NOT p_partial_today OR (p_hour_cutoff IS NOT NULL AND p_hour_cutoff > 0)) AS same_time_ok,
           -- no sales data at all is NULL (never 0)
           CASE WHEN cv.sales_state = 'no_data' THEN NULL ELSE COALESCE(s.g1, 0) END AS g1,
           CASE WHEN cv.sales_state = 'no_data' THEN NULL ELSE COALESCE(s.o1, 0) END AS o1,
           CASE WHEN cv.sales_state = 'no_data' THEN NULL ELSE COALESCE(s.u1, 0) END AS u1,
           CASE WHEN cv.sales_state = 'no_data' THEN NULL ELSE COALESCE(s.g0, 0) END AS g0,
           CASE WHEN cv.sales_state = 'no_data' THEN NULL ELSE COALESCE(s.o0, 0) END AS o0,
           CASE WHEN cv.sales_state = 'no_data' THEN NULL ELSE COALESCE(s.u0, 0) END AS u0,
           COALESCE(a.e1, 0) AS e1, COALESCE(a.i1, 0) AS i1, COALESCE(a.c1, 0) AS c1, COALESCE(a.dor1, 0) AS dor1, COALESCE(a.bo1, 0) AS bo1,
           COALESCE(a.dg1, 0) AS dg1, COALESCE(a.bg1, 0) AS bg1,
           COALESCE(a.e0, 0) AS e0, COALESCE(a.i0, 0) AS i0, COALESCE(a.c0, 0) AS c0, COALESCE(a.bo0, 0) AS bo0, COALESCE(a.bg0, 0) AS bg0,
           COALESCE(a.n0, 0) AS n0,
           sn.iid IS NOT NULL AS has_snapshot
    FROM public.shopee_products p
    JOIN cv ON cv.shop_id = p.shop_id
    LEFT JOIN sales s ON s.sid = p.shop_id AND s.iid = p.provider_item_id
    LEFT JOIN ads a ON a.sid = p.shop_id AND a.iid = p.provider_item_id
    LEFT JOIN camp c ON c.sid = p.shop_id AND c.iid = p.provider_item_id
    LEFT JOIN snap sn ON sn.sid = p.shop_id AND sn.iid = p.provider_item_id
    WHERE p.shop_id = ANY (p_shop_ids)
      AND (p_item_id IS NULL OR p.provider_item_id = p_item_id)
      AND (p_item_id IS NOT NULL OR s.iid IS NOT NULL OR a.iid IS NOT NULL OR c.single_n > 0)
  ),
  m AS (
    SELECT b.*,
           (b.current_complete AND b.previous_complete AND b.same_time_ok) AS sales_cmp,
           (NOT p_partial_today OR b.campaigns = 0 OR (b.same_time_ok AND b.n0 > 0)) AS ads_cmp,
           round(public.pa_ratio(b.bg1, b.e1), 4) AS r1,
           round(public.pa_ratio(b.bg0, b.e0), 4) AS r0
    FROM b
  )
  SELECT m.id, m.shop_id, m.provider_item_id, m.name, m.sku, m.image_url, m.provider_status, m.campaigns, m.shared,
         m.g1, m.o1, m.u1, m.g0, m.o0, m.u0,
         CASE WHEN m.sales_cmp THEN public.pa_pct(m.g1, m.g0) END,
         CASE WHEN m.sales_cmp THEN public.pa_pct(m.o1, m.o0) END,
         m.e1, m.e0,
         CASE WHEN m.ads_cmp AND m.campaigns > 0 THEN public.pa_pct(m.e1, m.e0) END,
         m.i1, m.c1, m.bo1, m.dor1, m.bg1, m.dg1,
         m.r1, m.r0,
         CASE WHEN m.ads_cmp AND m.campaigns > 0 THEN public.pa_pct(m.r1, m.r0) END,
         m.sales_state, m.covered_from, m.current_complete, m.sales_cmp, m.ads_cmp,
         public.pa_intelligence_eval(
           jsonb_build_object('gmv1', m.g1, 'gmv0', m.g0, 'orders1', m.o1, 'orders0', m.o0, 'units1', m.u1, 'units0', m.u0,
                              'spend1', m.e1, 'spend0', m.e0, 'impressions1', m.i1, 'impressions0', m.i0, 'clicks1', m.c1, 'clicks0', m.c0,
                              'broad_order1', m.bo1, 'broad_order0', m.bo0, 'broad_gmv1', m.bg1, 'broad_gmv0', m.bg0, 'campaigns', m.campaigns),
           jsonb_build_object('sales_state', m.sales_state, 'covered_from', m.covered_from,
                              'sales_current_complete', m.current_complete, 'sales_previous_complete', m.previous_complete,
                              'sales_comparable', m.sales_cmp, 'ads_comparable', m.ads_cmp, 'same_time_ok', m.same_time_ok,
                              'partial_today', p_partial_today, 'hour_cutoff', p_hour_cutoff,
                              'sales_stale', m.sales_stale, 'ads_stale', m.ads_stale, 'ads_missing', m.ads_missing,
                              'has_snapshot', m.has_snapshot, 'sales_age_minutes', m.sales_age_minutes, 'ads_age_minutes', m.ads_age_minutes),
           p_cfg)
  FROM m;
$$;


-- list-row shape (compact: top signals only; the full signal list is in the detail)
CREATE FUNCTION public.pa_intel_row(p jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT (p - ARRAY['intel', 'sk', 'sn', 'rn', 'cnt'])
         || jsonb_build_object(
              'health', p->'intel'->'health',
              'priority', p->'intel'->'priority',
              'needs_attention', p->'intel'->'needs_attention',
              'top_signals', p->'intel'->'top_signals',
              'signal_types', COALESCE((SELECT jsonb_agg(e->>'type') FROM jsonb_array_elements(p->'intel'->'signals') e), '[]'::jsonb),
              'data_quality', COALESCE((SELECT jsonb_agg(e->>'type') FROM jsonb_array_elements(p->'intel'->'data_quality') e), '[]'::jsonb));
$$;


-- ------------------------------------------------------------
-- E. list: server-side filter / search / sort / pagination + (optional) shop summary —
--    ONE round trip. The summary is computed from the same CTE (no second pass over
--    the rows): health distribution, shop-wide counts, per-shop context (medians),
--    hero totals (SHOP level: distinct orders, all Ads) and the top attention products.
--    "multiple products in this shop show a similar decline" = per-shop sales_down /
--    comparable — nothing here speaks about a market.
--    p_sort: priority | gmv | gmv_pct | orders | units | spend | broad_roas | roas_pct | name
-- ------------------------------------------------------------
CREATE FUNCTION public.product_intelligence_list(
  p_shop_ids uuid[], p_from date, p_to date, p_prev_from date, p_prev_to date,
  p_hour_cutoff integer, p_partial_today boolean, p_cfg jsonb,
  p_q text DEFAULT NULL, p_ads text DEFAULT 'all', p_status text DEFAULT 'all', p_health text DEFAULT 'all', p_signal text DEFAULT 'all',
  p_sort text DEFAULT 'priority', p_dir text DEFAULT 'desc', p_page integer DEFAULT 1, p_page_size integer DEFAULT 50,
  p_with_summary boolean DEFAULT true, p_top integer DEFAULT 6)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH r AS MATERIALIZED (
    SELECT x.*,
           (x.intel->'health'->>'label') AS health_label,
           (x.intel->>'needs_attention')::boolean AS attention,
           (x.intel->'priority'->>'score')::numeric AS score,
           ARRAY(SELECT e->>'type' FROM jsonb_array_elements(x.intel->'signals') e) AS sig_types
    FROM public.product_intelligence_rows(p_shop_ids, p_from, p_to, p_prev_from, p_prev_to, p_hour_cutoff, p_partial_today, p_cfg, NULL) x
  ),
  q AS (
    SELECT public.pa_fold(p_q) AS fq, LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS size,
           COALESCE(p_sort, 'priority') AS sort, COALESCE(p_dir, 'desc') AS dir
  ),
  f AS (
    SELECT r.*,
           CASE q.sort
             WHEN 'priority' THEN r.score
             WHEN 'gmv' THEN r.gmv WHEN 'gmv_pct' THEN r.gmv_pct WHEN 'orders' THEN r.orders WHEN 'units' THEN r.units
             WHEN 'spend' THEN r.spend WHEN 'broad_roas' THEN r.broad_roas WHEN 'roas_pct' THEN r.roas_pct
           END AS sk,
           CASE WHEN q.sort = 'name' THEN public.pa_fold(COALESCE(r.name, r.item_id)) END AS sn
    FROM r, q
    WHERE (COALESCE(p_ads, 'all') = 'all' OR (p_ads = 'with' AND r.campaigns > 0) OR (p_ads = 'without' AND r.campaigns = 0))
      AND (COALESCE(p_status, 'all') = 'all' OR COALESCE(r.status, 'UNKNOWN') = p_status)
      AND (COALESCE(p_health, 'all') = 'all' OR r.health_label = p_health OR (p_health = 'ATTENTION' AND r.attention))
      AND (COALESCE(p_signal, 'all') = 'all' OR p_signal = ANY (r.sig_types))
      AND (q.fq = '' OR NOT EXISTS (
            SELECT 1 FROM unnest(string_to_array(q.fq, ' ')) t
            WHERE t <> '' AND position(t IN public.pa_fold(COALESCE(r.name, '') || ' ' || COALESCE(r.sku, '') || ' ' || r.item_id)) = 0))
  ),
  pg AS (
    SELECT LEAST(GREATEST(COALESCE(p_page, 1), 1), GREATEST(1, ceil((SELECT count(*) FROM f)::numeric / q.size)::integer)) AS page, q.size
    FROM q
  ),
  o AS (
    SELECT f.*, row_number() OVER (ORDER BY
             (f.sk IS NULL AND q.sort <> 'name'),
             CASE WHEN q.dir = 'asc' THEN f.sk END ASC,
             CASE WHEN q.dir <> 'asc' THEN f.sk END DESC,
             CASE WHEN q.dir = 'asc' THEN f.sn END ASC,
             CASE WHEN q.dir <> 'asc' THEN f.sn END DESC,
             f.gmv DESC NULLS LAST, f.spend DESC, f.id) AS rn
    FROM f, q
  ),
  shops AS MATERIALIZED (
    SELECT * FROM public.product_intelligence_shops(p_shop_ids, p_from, p_prev_from, p_cfg)
  ),
  -- ---------------- summary (only evaluated when requested)
  cov AS (
    -- shops with NO sales data contribute nothing (they are listed in their own notice, sales_excluded_shops):
    -- they neither turn the other shops' exact totals into lower bounds nor block their comparison
    SELECT COALESCE(bool_and(current_complete) FILTER (WHERE sales_state <> 'no_data'), false) AS exact,
           COALESCE(bool_and(current_complete AND previous_complete) FILTER (WHERE sales_state <> 'no_data'), false) AS comparable,
           bool_and(sales_state = 'no_data') AS none,
           count(*) FILTER (WHERE sales_state = 'no_data') AS excluded,
           max(sales_last_success_at) AS sales_last, min(sales_last_success_at) AS sales_oldest,
           max(ads_today_at) AS ads_last,
           (NOT p_partial_today OR (p_hour_cutoff IS NOT NULL AND p_hour_cutoff > 0)) AS same_time_ok
    FROM shops
  ),
  hs AS (  -- shop-level sales: DISTINCT orders across products (Σ product orders would double count)
    SELECT count(DISTINCT f.provider_order_id) FILTER (WHERE f.valid_quantity > 0 AND f.report_date BETWEEN p_from AND p_to) AS o1,
           count(DISTINCT f.provider_order_id) FILTER (WHERE f.valid_quantity > 0 AND f.report_date BETWEEN p_prev_from AND p_prev_to) AS o0,
           COALESCE(sum(f.valid_quantity) FILTER (WHERE f.report_date BETWEEN p_from AND p_to), 0) AS u1,
           COALESCE(sum(f.valid_quantity) FILTER (WHERE f.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS u0,
           COALESCE(sum(f.valid_amount) FILTER (WHERE f.report_date BETWEEN p_from AND p_to), 0) AS g1,
           COALESCE(sum(f.valid_amount) FILTER (WHERE f.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS g0
    FROM public.shopee_product_sales_facts f
    WHERE p_with_summary AND f.shop_id = ANY (p_shop_ids) AND f.report_date BETWEEN LEAST(p_from, p_prev_from) AND GREATEST(p_to, p_prev_to)
      AND (p_hour_cutoff IS NULL OR extract(hour FROM f.order_created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') < p_hour_cutoff)
  ),
  ha AS (  -- shop-level Ads (all campaign types: the shop total fact)
    SELECT COALESCE(sum(x.expense) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0) AS e1,
           COALESCE(sum(x.expense) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS e0,
           COALESCE(sum(x.broad_gmv) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0) AS bg1,
           COALESCE(sum(x.broad_gmv) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS bg0,
           COALESCE(sum(x.clicks) FILTER (WHERE x.report_date BETWEEN p_from AND p_to), 0) AS c1,
           COALESCE(sum(x.clicks) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to), 0) AS c0,
           count(*) FILTER (WHERE x.report_date BETWEEN p_prev_from AND p_prev_to) AS n0
    FROM (
      SELECT d.report_date, d.expense, d.broad_gmv, d.clicks FROM public.shopee_ads_shop_daily_performance d
      WHERE p_with_summary AND p_hour_cutoff IS NULL AND d.shop_id = ANY (p_shop_ids) AND d.report_date BETWEEN LEAST(p_from, p_prev_from) AND GREATEST(p_to, p_prev_to)
      UNION ALL
      SELECT h.report_date, h.expense, h.broad_gmv, h.clicks FROM public.shopee_ads_shop_hourly_performance h
      WHERE p_with_summary AND p_hour_cutoff IS NOT NULL AND h.shop_id = ANY (p_shop_ids) AND h.report_date BETWEEN LEAST(p_from, p_prev_from) AND GREATEST(p_to, p_prev_to)
        AND h.report_hour < p_hour_cutoff
    ) x
  ),
  sc AS (
    SELECT r.shop_id, count(*) AS products,
           count(*) FILTER (WHERE r.sales_comparable AND r.prev_gmv >= (p_cfg->>'min_sales_gmv')::numeric) AS comparable,
           count(*) FILTER (WHERE 'SALES_DOWN' = ANY (r.sig_types)) AS sales_down,
           count(*) FILTER (WHERE 'SALES_UP' = ANY (r.sig_types)) AS sales_up,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.gmv_pct)
                 FILTER (WHERE r.sales_comparable AND r.prev_gmv >= (p_cfg->>'min_sales_gmv')::numeric)::numeric, 2) AS median_gmv_pct,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.broad_roas) FILTER (WHERE r.spend >= (p_cfg->>'min_ads_spend')::numeric)::numeric, 4) AS median_roas
    FROM r WHERE p_with_summary GROUP BY r.shop_id
  ),
  summary AS (
    SELECT jsonb_build_object(
      'health_counts', COALESCE((SELECT jsonb_object_agg(x.health_label, x.n) FROM (SELECT health_label, count(*) AS n FROM r GROUP BY 1) x), '{}'::jsonb),
      'products', (SELECT count(*) FROM r),
      'needs_attention', (SELECT count(*) FROM r WHERE r.attention),
      'sales_declining', (SELECT count(*) FROM r WHERE r.sig_types && ARRAY['SALES_DOWN', 'ORDERS_DOWN']),
      'sales_growing', (SELECT count(*) FROM r WHERE r.sig_types && ARRAY['SALES_UP', 'ORDERS_UP']),
      'ads_efficiency_declining', (SELECT count(*) FROM r WHERE r.sig_types && ARRAY['ADS_ROAS_DOWN', 'ADS_CVR_DOWN', 'ADS_CPC_UP']),
      'top_attention', COALESCE((
        SELECT jsonb_agg(public.pa_intel_row(to_jsonb(x) - ARRAY['health_label', 'attention', 'score', 'sig_types']) ORDER BY x.score DESC, x.gmv DESC NULLS LAST)
        FROM (SELECT * FROM r WHERE r.attention ORDER BY r.score DESC, r.gmv DESC NULLS LAST LIMIT GREATEST(COALESCE(p_top, 6), 0)) x), '[]'::jsonb),
      'shop_context', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'shop_id', sc.shop_id, 'products', sc.products, 'sales_comparable_products', sc.comparable,
                 'sales_down', sc.sales_down, 'sales_up', sc.sales_up,
                 'median_gmv_pct', sc.median_gmv_pct, 'median_broad_roas', sc.median_roas))
        FROM sc), '[]'::jsonb),
      'hero', jsonb_build_object(
        'sales_availability', CASE WHEN cov.none THEN 'no_data' WHEN cov.exact THEN 'complete' ELSE 'lower_bound' END,
        'sales_comparable', COALESCE(cov.comparable, false) AND cov.same_time_ok AND NOT COALESCE(cov.none, true),
        'ads_comparable', NOT p_partial_today OR (cov.same_time_ok AND ha.n0 > 0),
        'gmv', public.pa_delta(CASE WHEN cov.none THEN NULL ELSE hs.g1 END, CASE WHEN cov.comparable AND cov.same_time_ok AND NOT cov.none THEN hs.g0 END),
        'orders', public.pa_delta(CASE WHEN cov.none THEN NULL ELSE hs.o1 END, CASE WHEN cov.comparable AND cov.same_time_ok AND NOT cov.none THEN hs.o0 END),
        'units', public.pa_delta(CASE WHEN cov.none THEN NULL ELSE hs.u1 END, CASE WHEN cov.comparable AND cov.same_time_ok AND NOT cov.none THEN hs.u0 END),
        'ads_spend', public.pa_delta(ha.e1, CASE WHEN NOT p_partial_today OR (cov.same_time_ok AND ha.n0 > 0) THEN ha.e0 END),
        'ads_broad_gmv', public.pa_delta(ha.bg1, CASE WHEN NOT p_partial_today OR (cov.same_time_ok AND ha.n0 > 0) THEN ha.bg0 END),
        'ads_broad_roas', public.pa_delta(round(public.pa_ratio(ha.bg1, ha.e1), 4), CASE WHEN NOT p_partial_today OR (cov.same_time_ok AND ha.n0 > 0) THEN round(public.pa_ratio(ha.bg0, ha.e0), 4) END),
        'ads_clicks', public.pa_delta(ha.c1, CASE WHEN NOT p_partial_today OR (cov.same_time_ok AND ha.n0 > 0) THEN ha.c0 END),
        'sales_excluded_shops', cov.excluded,
        'sales_last_success_at', cov.sales_last, 'sales_oldest_success_at', cov.sales_oldest, 'ads_today_at', cov.ads_last)
    ) AS j
    FROM cov, hs, ha
    WHERE p_with_summary
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM r),
    'filtered', (SELECT count(*) FROM f),
    'page', (SELECT page FROM pg),
    'page_size', (SELECT size FROM pg),
    'rows', COALESCE((SELECT jsonb_agg(public.pa_intel_row(to_jsonb(o) - ARRAY['health_label', 'attention', 'score', 'sig_types']) ORDER BY o.rn)
                      FROM o, pg WHERE o.rn > (pg.page - 1) * pg.size AND o.rn <= pg.page * pg.size), '[]'::jsonb),
    'statuses', COALESCE((SELECT jsonb_agg(DISTINCT COALESCE(r.status, 'UNKNOWN')) FROM r), '[]'::jsonb),
    'shops', COALESCE((SELECT jsonb_agg(to_jsonb(shops)) FROM shops), '[]'::jsonb),
    'summary', (SELECT j FROM summary)
  );
$$;


-- Summary only (agent / future digest): the list with one row and its summary — same engine, same thresholds.
CREATE FUNCTION public.product_signal_summary(
  p_shop_ids uuid[], p_from date, p_to date, p_prev_from date, p_prev_to date,
  p_hour_cutoff integer, p_partial_today boolean, p_cfg jsonb, p_top integer DEFAULT 6)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT public.product_intelligence_list(p_shop_ids, p_from, p_to, p_prev_from, p_prev_to, p_hour_cutoff, p_partial_today, p_cfg,
           NULL, 'all', 'all', 'all', 'all', 'priority', 'desc', 1, 1, true, p_top)->'summary';
$$;


-- ------------------------------------------------------------
-- G. detail of ONE product: full intelligence row (all signals with evidence) + shop context
--    (product vs shop medians over the same period — a shop baseline, not a market claim)
-- ------------------------------------------------------------
CREATE FUNCTION public.product_intelligence_detail(
  p_shop_id uuid, p_item_id text, p_from date, p_to date, p_prev_from date, p_prev_to date,
  p_hour_cutoff integer, p_partial_today boolean, p_cfg jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH me AS (
    SELECT * FROM public.product_intelligence_rows(ARRAY[p_shop_id], p_from, p_to, p_prev_from, p_prev_to, p_hour_cutoff, p_partial_today, p_cfg, p_item_id)
  ),
  shop AS MATERIALIZED (
    SELECT * FROM public.product_intelligence_rows(ARRAY[p_shop_id], p_from, p_to, p_prev_from, p_prev_to, p_hour_cutoff, p_partial_today, p_cfg, NULL)
  ),
  ctx AS (
    SELECT count(*) AS products,
           count(*) FILTER (WHERE s.sales_comparable AND s.prev_gmv >= (p_cfg->>'min_sales_gmv')::numeric) AS comparable,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(s.intel->'signals') e WHERE e->>'type' = 'SALES_DOWN')) AS sales_down,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.gmv_pct)
                 FILTER (WHERE s.sales_comparable AND s.prev_gmv >= (p_cfg->>'min_sales_gmv')::numeric)::numeric, 2) AS median_gmv_pct,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.broad_roas) FILTER (WHERE s.spend >= (p_cfg->>'min_ads_spend')::numeric)::numeric, 4) AS median_roas
    FROM shop s
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM me) THEN NULL ELSE jsonb_build_object(
    'row', (SELECT to_jsonb(me) FROM me),
    'shop_context', (
      SELECT jsonb_build_object(
        'products', ctx.products, 'sales_comparable_products', ctx.comparable, 'sales_down', ctx.sales_down,
        'median_gmv_pct', ctx.median_gmv_pct, 'median_broad_roas', ctx.median_roas,
        'product_gmv_pct_minus_median', CASE WHEN me.gmv_pct IS NOT NULL AND ctx.median_gmv_pct IS NOT NULL THEN round(me.gmv_pct - ctx.median_gmv_pct, 2) END,
        'product_roas_vs_median_pct', CASE WHEN me.spend >= (p_cfg->>'min_ads_spend')::numeric THEN public.pa_pct(me.broad_roas, ctx.median_roas) END)
      FROM ctx, me),
    'shop', (SELECT to_jsonb(x) FROM public.product_intelligence_shops(ARRAY[p_shop_id], p_from, p_prev_from, p_cfg) x)
  ) END;
$$;


-- ------------------------------------------------------------
-- H. baseline: add volatility (stddev, coefficient of variation) — same signature as 00070
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.product_analytics_baseline(p_shop_id uuid, p_item_id text, p_from date, p_to date)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH d AS (SELECT * FROM public.product_analytics_daily(p_shop_id, p_item_id, p_from, p_to)),
  m AS (
    SELECT 'sales_gmv' AS metric, gmv::numeric AS v FROM d UNION ALL
    SELECT 'orders', orders::numeric FROM d UNION ALL
    SELECT 'units', units::numeric FROM d UNION ALL
    SELECT 'ads_spend', spend::numeric FROM d UNION ALL
    SELECT 'ads_broad_gmv', broad_gmv::numeric FROM d UNION ALL
    SELECT 'ads_clicks', clicks::numeric FROM d
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', (SELECT count(*) FROM d),
    'days_with_sales', (SELECT count(*) FROM d WHERE orders > 0),
    'metrics', (SELECT jsonb_object_agg(x.metric, x.stats) FROM (
        SELECT metric, jsonb_build_object(
          'mean', round(avg(v), 2),
          'median', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY v)::numeric, 2),
          'p25', round(percentile_cont(0.25) WITHIN GROUP (ORDER BY v)::numeric, 2),
          'p75', round(percentile_cont(0.75) WITHIN GROUP (ORDER BY v)::numeric, 2),
          'stddev', round(stddev_pop(v), 2),
          -- coefficient of variation (stddev / mean): day-to-day volatility, NULL when the mean is 0
          'cv', round(public.pa_ratio(stddev_pop(v), avg(v)), 3),
          'total', sum(v)) AS stats
        FROM m GROUP BY metric) x));
$$;


-- ------------------------------------------------------------
-- I. grants (cloud has no default EXECUTE grants — explicit, service_role only)
-- ------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'pa_fold(text)',
    'pa_conf_down(text)',
    'pa_conf_rank(text)',
    'pa_jappend(jsonb, jsonb)',
    'pa_pct(numeric, numeric)',
    'pa_signal(text, text, text, text, text, numeric, numeric, numeric, numeric, numeric, text, boolean, text)',
    'pa_intelligence_eval(jsonb, jsonb, jsonb)',
    'product_intelligence_shops(uuid[], date, date, jsonb)',
    'product_intelligence_rows(uuid[], date, date, date, date, integer, boolean, jsonb, text)',
    'pa_intel_row(jsonb)',
    'product_intelligence_list(uuid[], date, date, date, date, integer, boolean, jsonb, text, text, text, text, text, text, text, integer, integer, boolean, integer)',
    'product_signal_summary(uuid[], date, date, date, date, integer, boolean, jsonb, integer)',
    'product_intelligence_detail(uuid, text, date, date, date, date, integer, boolean, jsonb)',
    'product_analytics_baseline(uuid, text, date, date)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END;
$$;
