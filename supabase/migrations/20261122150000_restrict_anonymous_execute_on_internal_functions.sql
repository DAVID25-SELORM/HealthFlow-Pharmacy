-- Close three database functions to signed-out callers.
--
-- A production security check (2026-11-22) found three elevated-rights database functions that
-- anyone without signing in could run over the public API, because PostgreSQL grants
-- EXECUTE to PUBLIC by default and nothing revoked it:
--   next_nhis_claim_number(uuid)                    could use up a pharmacy's claim numbers
--   recompute_nhis_claim_total(uuid)                could change a claim's last-updated time
--   branch_belongs_to_organization(uuid, uuid)      could reveal whether a branch belongs to a pharmacy
--
-- Nothing legitimate needs signed-out access: the app never calls them, the two claim
-- functions are only called by elevated-rights triggers (which run as the table owner),
-- and the branch function is only used by two `users` policies that apply to signed-in staff.
--
-- This changes permissions only. It does not change any function body, NHIS pricing, claim
-- numbering, totals, tariffs, exports, duplicate detection, sync or RLS policies.
-- Signed-in staff (authenticated) and the service role keep EXECUTE.

do $$
declare
  fn regprocedure;
begin
  foreach fn in array array[
    to_regprocedure('public.next_nhis_claim_number(uuid)'),
    to_regprocedure('public.recompute_nhis_claim_total(uuid)'),
    to_regprocedure('public.branch_belongs_to_organization(uuid, uuid)')
  ]
  loop
    if fn is not null then
      execute format('revoke execute on function %s from public, anon', fn);
      execute format('grant execute on function %s to authenticated, service_role', fn);
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
