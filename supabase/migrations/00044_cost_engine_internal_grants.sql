-- ============================================================
-- Fix 00043: grant EXECUTE on the cost engine's internal helpers to service_role
--
-- 00043 revoked EXECUTE from PUBLIC on every cost function but granted
-- service_role only the entry points. The helpers are SECURITY INVOKER, so
-- they run as the caller (service_role) and need EXECUTE too. Local Docker
-- Supabase masked this via default privileges; on cloud every receipt_items
-- insert failed with "permission denied for function
-- cost_rebuild_product_safe", rolling back create_receipt/update_receipt.
-- ============================================================
GRANT EXECUTE ON FUNCTION public.cost_lock_state(uuid)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.cost_replay_product(uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.cost_sync_purchases(uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.cost_rebuild_product_safe(uuid, text)  TO service_role;
