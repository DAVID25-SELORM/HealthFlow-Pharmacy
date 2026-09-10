-- Staff clients call these RPCs directly. Preserve authenticated execution
-- and existing function-body authorization while closing anonymous access.
-- Branch-sync uses separate token-authenticated RPCs and is unaffected.
begin;

revoke execute on function public.create_sale_transaction(jsonb) from public, anon;
revoke execute on function public.complete_purchase(uuid) from public, anon;

grant execute on function public.create_sale_transaction(jsonb) to authenticated, service_role;
grant execute on function public.complete_purchase(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
