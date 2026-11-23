-- Close the interface-flag function to signed-out callers.
--
-- set_organization_interface_flag (20261122120000) revoked EXECUTE from PUBLIC, but Supabase also
-- grants EXECUTE on new functions to the anon role directly, so signed-out callers could still
-- reach it over the public API. The function already refuses anyone who is not an active platform
-- administrator, so no data was exposed; this removes the reachability, in line with 20261122150000.
-- Permissions only: no function body, flag or data changes.

do $$
declare
  fn regprocedure := to_regprocedure('public.set_organization_interface_flag(uuid, text, boolean)');
begin
  if fn is not null then
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end if;
end;
$$;

notify pgrst, 'reload schema';
