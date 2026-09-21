-- ============================================================
-- PHASE 8: Database-level non-negative guards on receipt_items
-- The app validates unit_price/delivered_qty/received_qty >= 0 with Zod,
-- but that's bypassable by anything calling the database directly (or a
-- future caller of create_receipt that skips the app layer). Enforce the
-- same rule as a CHECK constraint so the database is the final authority.
-- ============================================================

ALTER TABLE public.receipt_items
  ADD CONSTRAINT receipt_items_unit_price_nonnegative CHECK (unit_price >= 0),
  ADD CONSTRAINT receipt_items_delivered_qty_nonnegative CHECK (delivered_qty >= 0),
  ADD CONSTRAINT receipt_items_received_qty_nonnegative CHECK (received_qty >= 0);
