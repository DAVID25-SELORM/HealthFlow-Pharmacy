-- Do not activate the policy until the branch-serving sync transaction is
-- deployed with this guard.  This migration deliberately makes an unsafe
-- partial rollout impossible: an organization cannot turn the policy on until
-- its serving authority advertises the matching protocol version.

alter table public.pharmacy_settings
  add column if not exists nhis_inventory_serving_protocol_version integer not null default 0;

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
    where actor.id = auth.uid()
      and actor.organization_id = new.organization_id
      and actor.is_active is distinct from false
      and (actor.role in ('admin', 'super_admin')
        or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[])
  ) then
    raise exception 'Only an active administrator can change the NHIS inventory policy.' using errcode = '42501';
  end if;

  if new.nhis_deduct_inventory_on_serve
     and coalesce(new.nhis_inventory_serving_protocol_version, 0) < 1 then
    raise exception 'NHIS inventory deduction cannot be enabled until the serving and offline-sync protocol is installed.' using errcode = '55000';
  end if;

  perform public.log_audit_event(
    'settings.nhis_inventory_policy_changed', 'pharmacy_settings', new.id, 'update',
    jsonb_build_object(
      'organization_id', new.organization_id,
      'previous_value', old.nhis_deduct_inventory_on_serve,
      'new_value', new.nhis_deduct_inventory_on_serve,
      'protocol_version', new.nhis_inventory_serving_protocol_version
    ), new.organization_id
  );
  return new;
end;
$$;

comment on column public.pharmacy_settings.nhis_inventory_serving_protocol_version is
  'Deployment guard for the paired cloud and branch NHIS inventory-serving protocol.';

notify pgrst, 'reload schema';
