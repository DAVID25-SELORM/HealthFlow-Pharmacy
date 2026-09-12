-- Live Chrome audit: twelve internal trigger functions exposed to anon.
-- Existing triggers and function bodies remain unchanged. Token-authenticated
-- branch-sync RPCs and ordinary staff RPC grants are not modified.
begin;
revoke execute on function public.apply_direct_nhis_inventory_effect() from public, anon, authenticated;
revoke execute on function public.apply_dispensary_nhis_inventory_effect() from public, anon, authenticated;
revoke execute on function public.assign_nhis_claim_number() from public, anon, authenticated;
revoke execute on function public.enforce_chemical_shop_organization_settings() from public, anon, authenticated;
revoke execute on function public.enforce_nhis_claim_medicine_catalog_pricing() from public, anon, authenticated;
revoke execute on function public.guard_nhis_inventory_policy_change() from public, anon, authenticated;
revoke execute on function public.preserve_server_nhis_claim_total() from public, anon, authenticated;
revoke execute on function public.prevent_chemical_shop_restricted_stock_change() from public, anon, authenticated;
revoke execute on function public.prevent_chemical_shop_restricted_stock_insert() from public, anon, authenticated;
revoke execute on function public.prevent_chemical_shop_restricted_transaction() from public, anon, authenticated;
revoke execute on function public.prevent_mca_changes_to_direct_nhis_serving() from public, anon, authenticated;
revoke execute on function public.quarantine_inventory_after_chemical_shop_conversion() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
