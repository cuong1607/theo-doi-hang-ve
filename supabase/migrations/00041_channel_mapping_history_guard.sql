-- ============================================================
-- PRE-SHOPEE-3: protect mapping history once orders use a mapping.
--
-- Rule: an order item that was resolved to an internal product keeps that
-- product forever (its own snapshot), and the sellable unit it was resolved
-- through cannot be silently unmapped / remapped.
--
--   channel_order_items.channel_model_id  the sellable unit (channel_product_models)
--     the order line was resolved to. Set by order sync (SHOPEE-3) once the
--     identity rule is confirmed against real payloads; nullable until then.
--     NO ACTION (not cascade/set null): a used unit can't be deleted on its own
--     (deleting the whole shop still cascades both sides in one statement).
--
--   channel_order_items / channel_return_items .internal_product_id
--     ON DELETE SET NULL → NO ACTION: deleting a product must never erase the
--     product snapshot of historical order/return lines.
--
--   guard_channel_model_mapping (BEFORE UPDATE on channel_product_models):
--     while ANY order item references the unit, changing internal_product_id
--       * to NULL (unmap)                                  → error CM001
--       * to another product outside the controlled flow   → error CM002
--     The controlled flow is change_channel_model_mapping(): it requires a
--     non-null target and a written reason, marks the transaction, and every
--     change is recorded in channel_model_mapping_history. Historical order
--     items are NOT touched — they keep their own internal_product_id.
--
--   channel_model_mapping_history: append-only audit of every mapping change
--     (auto, manual, unmap, controlled), written by trigger.
-- ============================================================

ALTER TABLE public.channel_order_items
  ADD COLUMN channel_model_id uuid REFERENCES public.channel_product_models(id) ON DELETE NO ACTION;
CREATE INDEX idx_channel_order_items_channel_model_id ON public.channel_order_items (channel_model_id);

ALTER TABLE public.channel_order_items DROP CONSTRAINT channel_order_items_internal_product_id_fkey;
ALTER TABLE public.channel_order_items
  ADD CONSTRAINT channel_order_items_internal_product_id_fkey
  FOREIGN KEY (internal_product_id) REFERENCES public.products(id) ON DELETE NO ACTION;

ALTER TABLE public.channel_return_items DROP CONSTRAINT channel_return_items_internal_product_id_fkey;
ALTER TABLE public.channel_return_items
  ADD CONSTRAINT channel_return_items_internal_product_id_fkey
  FOREIGN KEY (internal_product_id) REFERENCES public.products(id) ON DELETE NO ACTION;


-- ------------------------------------------------------------
-- Audit history
-- ------------------------------------------------------------
CREATE TABLE public.channel_model_mapping_history (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_model_id          uuid        NOT NULL REFERENCES public.channel_product_models(id) ON DELETE CASCADE,
  -- No FK on purpose: an audit row must keep the ids even after a product is
  -- deleted (and is written while that delete's ON DELETE SET NULL runs).
  old_internal_product_id   uuid,
  new_internal_product_id   uuid,
  old_mapping_status        text        NOT NULL,
  new_mapping_status        text        NOT NULL,
  change_kind               text        NOT NULL CHECK (change_kind IN ('map', 'unmap', 'remap', 'status', 'controlled_remap')),
  reason                    text,
  changed_by                uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  order_items_at_change     integer     NOT NULL DEFAULT 0,
  changed_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_channel_model_mapping_history_model ON public.channel_model_mapping_history (channel_model_id, changed_at DESC);

ALTER TABLE public.channel_model_mapping_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_model_mapping_history FROM anon, authenticated;
GRANT SELECT ON public.channel_model_mapping_history TO authenticated;
GRANT SELECT, INSERT ON public.channel_model_mapping_history TO service_role;
CREATE POLICY active_users_select ON public.channel_model_mapping_history
  FOR SELECT TO authenticated USING (public.is_active_user());


-- ------------------------------------------------------------
-- Guard (fires before reset_channel_model_mapping: "guard_" < "reset_")
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_channel_model_mapping()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.internal_product_id IS NULL
     OR OLD.internal_product_id IS NOT DISTINCT FROM NEW.internal_product_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.channel_order_items oi WHERE oi.channel_model_id = OLD.id) THEN
    RETURN NEW;
  END IF;
  IF NEW.internal_product_id IS NULL THEN
    RAISE EXCEPTION 'Biến thể này đã có đơn hàng sử dụng mapping — không được bỏ ghép.'
      USING ERRCODE = 'CM001';
  END IF;
  IF current_setting('app.channel_mapping_change', true) IS DISTINCT FROM 'controlled' THEN
    RAISE EXCEPTION 'Biến thể này đã có đơn hàng — đổi mapping phải qua quy trình điều chỉnh có lý do.'
      USING ERRCODE = 'CM002';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_channel_model_mapping() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_channel_model_mapping
  BEFORE UPDATE OF internal_product_id ON public.channel_product_models
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_channel_model_mapping();


CREATE OR REPLACE FUNCTION public.log_channel_model_mapping()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_kind text;
  v_controlled boolean := current_setting('app.channel_mapping_change', true) = 'controlled';
BEGIN
  IF OLD.internal_product_id IS NOT DISTINCT FROM NEW.internal_product_id
     AND OLD.mapping_status = NEW.mapping_status THEN
    RETURN NULL;
  END IF;
  v_kind := CASE
    WHEN OLD.internal_product_id IS NOT DISTINCT FROM NEW.internal_product_id THEN 'status'
    WHEN NEW.internal_product_id IS NULL THEN 'unmap'
    WHEN OLD.internal_product_id IS NULL THEN 'map'
    WHEN v_controlled THEN 'controlled_remap'
    ELSE 'remap'
  END;
  INSERT INTO public.channel_model_mapping_history (
    channel_model_id, old_internal_product_id, new_internal_product_id,
    old_mapping_status, new_mapping_status, change_kind, reason, changed_by, order_items_at_change
  ) VALUES (
    NEW.id, OLD.internal_product_id, NEW.internal_product_id,
    OLD.mapping_status, NEW.mapping_status, v_kind,
    CASE WHEN v_controlled THEN NULLIF(current_setting('app.channel_mapping_reason', true), '') END,
    CASE WHEN v_controlled THEN NULLIF(current_setting('app.channel_mapping_changed_by', true), '')::uuid ELSE NEW.mapped_by END,
    (SELECT count(*) FROM public.channel_order_items oi WHERE oi.channel_model_id = NEW.id)
  );
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_channel_model_mapping() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER log_channel_model_mapping
  AFTER UPDATE OF internal_product_id, mapping_status ON public.channel_product_models
  FOR EACH ROW
  EXECUTE FUNCTION public.log_channel_model_mapping();


-- ------------------------------------------------------------
-- Controlled remap (the ONLY way to change a mapping already used by orders)
-- Custom SQLSTATEs: CM003 bad input, CM004 not found.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_channel_model_mapping(
  p_channel_model_id    uuid,
  p_internal_product_id uuid,
  p_reason              text,
  p_changed_by          uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_internal_product_id IS NULL THEN
    RAISE EXCEPTION 'Phải chọn sản phẩm nội bộ mới (không được bỏ ghép).' USING ERRCODE = 'CM003';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'Phải ghi lý do điều chỉnh (tối thiểu 5 ký tự).' USING ERRCODE = 'CM003';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_internal_product_id) THEN
    RAISE EXCEPTION 'Không tìm thấy sản phẩm nội bộ.' USING ERRCODE = 'CM004';
  END IF;

  PERFORM set_config('app.channel_mapping_change', 'controlled', true);
  PERFORM set_config('app.channel_mapping_reason', btrim(p_reason), true);
  PERFORM set_config('app.channel_mapping_changed_by', COALESCE(p_changed_by::text, ''), true);

  UPDATE public.channel_product_models
  SET internal_product_id = p_internal_product_id,
      mapping_status = 'manual_mapped',
      mapped_at = now(),
      mapped_by = p_changed_by,
      mapping_review_required = false
  WHERE id = p_channel_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy biến thể.' USING ERRCODE = 'CM004';
  END IF;

  PERFORM set_config('app.channel_mapping_change', '', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.change_channel_model_mapping(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_channel_model_mapping(uuid, uuid, text, uuid) TO service_role;


-- ------------------------------------------------------------
-- Listing view: expose how many order lines use each unit (appended column).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_channel_model_listing
WITH (security_invoker = true)
AS
SELECT
  m.id                              AS channel_model_id,
  s.id                              AS shop_id,
  s.shop_name,
  s.channel,
  s.data_source,
  cp.id                             AS channel_product_id,
  cp.external_item_id,
  cp.item_name,
  cp.item_sku,
  cp.item_status,
  cp.is_kit,
  cp.has_model,
  m.external_model_id,
  m.is_synthetic,
  m.model_name,
  m.model_sku,
  m.model_status,
  CASE WHEN m.is_synthetic THEN cp.item_sku ELSE m.model_sku END AS channel_sku,
  COALESCE(m.channel_current_price, cp.channel_current_price)::text   AS channel_current_price,
  COALESCE(m.channel_original_price, cp.channel_original_price)::text AS channel_original_price,
  COALESCE(m.available_stock, cp.available_stock)::text               AS available_stock,
  COALESCE(m.reserved_stock, cp.reserved_stock)::text                 AS reserved_stock,
  m.mapping_status,
  m.mapping_review_required,
  m.mapped_at,
  m.mapped_by,
  m.removed_at,
  (m.removed_at IS NULL AND cp.item_status = 'NORMAL') AS is_active,
  m.internal_product_id,
  p.sku                             AS internal_sku,
  p.name                            AS internal_product_name,
  COALESCE(m.last_synced_at, cp.last_synced_at) AS last_synced_at,
  (SELECT count(*) FROM public.channel_order_items oi WHERE oi.channel_model_id = m.id) AS order_item_count
FROM public.channel_product_models m
JOIN public.channel_products cp ON cp.id = m.channel_product_id
JOIN public.shops s             ON s.id = cp.shop_id
LEFT JOIN public.products p     ON p.id = m.internal_product_id;
