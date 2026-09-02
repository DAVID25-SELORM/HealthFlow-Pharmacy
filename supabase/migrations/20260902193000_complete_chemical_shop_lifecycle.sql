-- Complete Chemical Shop tenant isolation and lifecycle enforcement.
-- This migration is intentionally conditional: pharmacy and hospital tenants
-- retain their existing modules and inventory behavior.

create or replace function public.can_review_restricted_inventory(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and coalesce(u.is_active, true)
      and (
        lower(coalesce(u.role, '')) = 'super_admin'
        or coalesce(u.assigned_roles, '{}'::text[]) && array['super_admin']::text[]
        or (
          u.organization_id = p_organization_id
          and (
            lower(coalesce(u.role, '')) in ('compliance_admin', 'compliance_officer')
            or coalesce(u.assigned_roles, '{}'::text[]) && array['compliance_admin', 'compliance_officer']::text[]
            or (
              coalesce(u.can_manage_restricted_inventory, false)
              and (
                lower(coalesce(u.role, '')) in ('admin', 'supervisor')
                or coalesce(u.assigned_roles, '{}'::text[]) && array['admin', 'supervisor']::text[]
              )
            )
          )
        )
      )
  );
$$;

revoke all on function public.can_review_restricted_inventory(uuid) from public, anon;
grant execute on function public.can_review_restricted_inventory(uuid) to authenticated;

create or replace function public.enforce_chemical_shop_organization_settings()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if lower(coalesce(new.organization_type, '')) = 'chemical_shop' then
    new.pharmacy_level := null;
    new.can_use_claims := false;
    new.can_use_nhis := false;
    new.can_use_nhis_topups := false;
    new.nhis_top_up_policy := 'not_allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_chemical_shop_organization_settings on public.organizations;
create trigger enforce_chemical_shop_organization_settings
before insert or update of organization_type, pharmacy_level, can_use_claims,
  can_use_nhis, can_use_nhis_topups, nhis_top_up_policy
on public.organizations
for each row execute function public.enforce_chemical_shop_organization_settings();

create or replace function public.quarantine_disallowed_chemical_shop_inventory(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_moved integer := 0;
begin
  if not public.is_chemical_shop_organization(p_organization_id) then
    return 0;
  end if;

  with moved as (
    insert into public.restricted_inventory (
      organization_id, branch_id, drug_id, medicine_name, quantity, source,
      quarantine_reason, created_at
    )
    select d.organization_id, d.branch_id, d.id, d.name, d.quantity,
           'Chemical Shop conversion',
           'Medicine classification is not permitted for Chemical Shop operations.', now()
    from public.drugs d
    where d.organization_id = p_organization_id
      and coalesce(d.quantity, 0) > 0
      and not public.is_drug_allowed_for_chemical_shop(d)
      and not exists (
        select 1
        from public.restricted_inventory r
        where r.drug_id = d.id
          and r.status in ('quarantined', 'under_review')
      )
    returning id, organization_id, quarantine_reason
  ), audited as (
    insert into public.restricted_inventory_audit (
      restricted_inventory_id, organization_id, action, new_status, reason
    )
    select id, organization_id, 'quarantined', 'quarantined', quarantine_reason
    from moved
    returning 1
  )
  select count(*) into v_moved from audited;

  update public.drugs d
  set quantity = 0,
      updated_at = now()
  where d.organization_id = p_organization_id
    and coalesce(d.quantity, 0) > 0
    and not public.is_drug_allowed_for_chemical_shop(d);

  return v_moved;
end;
$$;

revoke all on function public.quarantine_disallowed_chemical_shop_inventory(uuid)
  from public, anon, authenticated;

create or replace function public.quarantine_inventory_after_chemical_shop_conversion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if lower(coalesce(new.organization_type, '')) = 'chemical_shop'
     and lower(coalesce(old.organization_type, '')) is distinct from 'chemical_shop' then
    perform public.quarantine_disallowed_chemical_shop_inventory(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists quarantine_inventory_after_chemical_shop_conversion on public.organizations;
create trigger quarantine_inventory_after_chemical_shop_conversion
after update of organization_type on public.organizations
for each row execute function public.quarantine_inventory_after_chemical_shop_conversion();

-- Repair any Chemical Shop tenants created or converted before this migration.
update public.organizations
set can_use_claims = false,
    can_use_nhis = false,
    can_use_nhis_topups = false,
    nhis_top_up_policy = 'not_allowed',
    pharmacy_level = null,
    updated_at = now()
where lower(coalesce(organization_type, '')) = 'chemical_shop';

do $$
declare
  v_organization_id uuid;
begin
  for v_organization_id in
    select id
    from public.organizations
    where lower(coalesce(organization_type, '')) = 'chemical_shop'
  loop
    perform public.quarantine_disallowed_chemical_shop_inventory(v_organization_id);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
