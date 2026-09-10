-- Completion trusts actor IDs supplied by tier-access after role, tenant and
-- order-transition checks. Direct browser/anonymous callers must not supply
-- these identities themselves. Revoke both inherited PUBLIC and explicit
-- client grants, including grants left in older production environments.
begin;

revoke execute on function public.complete_epharmacy_order(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.complete_customer_epharmacy_order(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.complete_epharmacy_order(uuid, uuid, uuid)
  to service_role;
grant execute on function public.complete_customer_epharmacy_order(uuid, uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
commit;
