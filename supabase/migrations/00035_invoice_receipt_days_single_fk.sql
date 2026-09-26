-- ============================================================
-- PHASE INV-FROM-RECEIPTS fix: invoice_receipt_days had TWO foreign keys to
-- invoices (invoice_id -> invoices.id, and the composite
-- (invoice_id, supplier_id) -> invoices(id, supplier_id) added for
-- supplier integrity). PostgREST then can't pick a relationship for embeds
-- like invoices(..., invoice_receipt_days(...)) and errors out.
--
-- The composite FK alone already guarantees everything the single one did
-- (invoice exists, ON DELETE CASCADE) plus the supplier match, so the
-- single-column FK is redundant — drop it.
-- ============================================================
ALTER TABLE public.invoice_receipt_days
  DROP CONSTRAINT invoice_receipt_days_invoice_id_fkey;
