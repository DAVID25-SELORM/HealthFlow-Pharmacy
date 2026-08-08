-- Prevent authenticated users from changing their own tenant assignment,
-- account status, role, or permission flags through direct table updates.
-- Authorized staff administration continues through the staff-admin function.

create or replace function public.prevent_user_self_privilege_escalation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_key text;
  v_protected_keys constant text[] := array[
    'id',
    'role',
    'assigned_roles',
    'organization_id',
    'branch_id',
    'is_active',
    'can_refund',
    'can_manage_inventory',
    'can_view_reports',
    'can_manage_claims',
    'can_manage_purchases',
    'can_process_sales',
    'can_manage_patients',
    'can_manage_accounting',
    'can_manage_epharmacy',
    'can_view_activity_log',
    'can_adjust_stock',
    'can_approve_purchases',
    'can_delete_nhis_claims'
  ];
begin
  -- Service-role and trusted server operations have no end-user auth.uid().
  if auth.uid() is null or auth.uid() <> old.id then
    return new;
  end if;

  foreach v_key in array v_protected_keys loop
    -- The existence checks keep this migration compatible with older schemas
    -- that do not yet contain every optional permission column.
    if v_old ? v_key
       and v_new ? v_key
       and (v_old -> v_key) is distinct from (v_new -> v_key) then
      raise exception using
        errcode = '42501',
        message = 'You cannot change your own role, tenant assignment, account status, or permissions.';
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.prevent_user_self_privilege_escalation() from public;
revoke all on function public.prevent_user_self_privilege_escalation() from anon;
revoke all on function public.prevent_user_self_privilege_escalation() from authenticated;

drop trigger if exists prevent_user_self_privilege_escalation on public.users;
create trigger prevent_user_self_privilege_escalation
before update on public.users
for each row
execute function public.prevent_user_self_privilege_escalation();

comment on function public.prevent_user_self_privilege_escalation() is
  'Blocks end users from changing their own role, tenant assignment, status, or permission flags while preserving ordinary profile updates and trusted staff administration.';
