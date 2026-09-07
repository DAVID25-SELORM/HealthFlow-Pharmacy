alter table public.branch_sync_clients
  add column if not exists nhis_inventory_protocol_version integer not null default 0;

-- Version 1 is this deployed cloud protocol. A branch must explicitly attest
-- after it has installed the matching local event/ledger implementation.
update public.pharmacy_settings
set nhis_inventory_serving_protocol_version = 1
where nhis_inventory_serving_protocol_version = 0;

create or replace function public.branch_sync_report_nhis_inventory_protocol(
  p_sync_token text,
  p_protocol_version integer
)
returns void
language plpgsql
security definer
set search_path = public, extensions
set row_security = off
as $$
declare
  v_client public.branch_sync_clients%rowtype;
begin
  if p_protocol_version <> 1 then
    raise exception 'Unsupported NHIS inventory serving protocol version.' using errcode = '22023';
  end if;
  v_client := public.get_branch_sync_client(p_sync_token);
  update public.branch_sync_clients
  set nhis_inventory_protocol_version = p_protocol_version, last_seen_at = now()
  where id = v_client.id;
end;
$$;

create or replace function public.guard_nhis_inventory_policy_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.nhis_deduct_inventory_on_serve is not distinct from old.nhis_deduct_inventory_on_serve then
    return new;
  end if;
  if not exists (
    select 1 from public.users actor
    where actor.id = auth.uid() and actor.organization_id = new.organization_id
      and actor.is_active is distinct from false
      and (actor.role in ('admin', 'super_admin')
        or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[])
  ) then
    raise exception 'Only an active administrator can change the NHIS inventory policy.' using errcode = '42501';
  end if;
  if new.nhis_deduct_inventory_on_serve and exists (
    select 1 from public.branch_sync_clients client
    where client.organization_id = new.organization_id and client.is_active
      and client.nhis_inventory_protocol_version < 1
  ) then
    raise exception 'Update every active branch server before enabling NHIS inventory deduction.' using errcode = '55000';
  end if;
  perform public.log_audit_event(
    'settings.nhis_inventory_policy_changed', 'pharmacy_settings', new.id, 'update',
    jsonb_build_object('organization_id', new.organization_id,
      'previous_value', old.nhis_deduct_inventory_on_serve,
      'new_value', new.nhis_deduct_inventory_on_serve), new.organization_id
  );
  return new;
end;
$$;

revoke all on function public.branch_sync_report_nhis_inventory_protocol(text, integer) from public;
grant execute on function public.branch_sync_report_nhis_inventory_protocol(text, integer) to anon, authenticated;

notify pgrst, 'reload schema';
