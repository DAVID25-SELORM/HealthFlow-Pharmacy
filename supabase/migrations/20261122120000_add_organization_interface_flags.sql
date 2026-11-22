-- Per-pharmacy interface switches.
-- Lets the platform administrator switch a large interface redesign off for one
-- pharmacy without a new release. Nothing is switched on or off by this migration:
-- an empty flag set means "use the current interface", exactly as today.
-- It does not touch NHIS, claims, pricing, stock, tariffs, exports or sync.

alter table public.organizations
  add column if not exists interface_flags jsonb not null default '{}'::jsonb;

comment on column public.organizations.interface_flags is
  'Interface switches set by the platform administrator, e.g. {"classic_navigation": true}. Empty means the current interface.';

create or replace function public.set_organization_interface_flag(
  p_org uuid,
  p_flag text,
  p_value boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_flags jsonb;
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and is_active = true and role = 'super_admin'
  ) then
    raise exception 'Platform administrator required';
  end if;

  if p_flag is null or p_flag not in ('classic_navigation') then
    raise exception 'Unknown interface flag';
  end if;

  if p_value is null then
    raise exception 'A true or false value is required';
  end if;

  update public.organizations
  set interface_flags = coalesce(interface_flags, '{}'::jsonb) || jsonb_build_object(p_flag, p_value)
  where id = p_org
  returning interface_flags into v_flags;

  if not found then
    raise exception 'Facility not found';
  end if;

  return v_flags;
end;
$$;

revoke all on function public.set_organization_interface_flag(uuid, text, boolean) from public;
grant execute on function public.set_organization_interface_flag(uuid, text, boolean) to authenticated;

notify pgrst, 'reload schema';
