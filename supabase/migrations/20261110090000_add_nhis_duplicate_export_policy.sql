-- Additive organization policy for duplicate NHIS exports.
-- The default remains blocked; existing per-group review is unchanged.
begin;

create table if not exists public.organization_nhis_duplicate_export_policy (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  allow_duplicate_exports boolean not null default false,
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.nhis_duplicate_export_policy_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid not null references public.users(id) on delete restrict,
  previous_allow_duplicate_exports boolean not null,
  new_allow_duplicate_exports boolean not null,
  created_at timestamptz not null default now()
);

alter table public.organization_nhis_duplicate_export_policy enable row level security;
alter table public.nhis_duplicate_export_policy_audit enable row level security;
revoke all on public.organization_nhis_duplicate_export_policy, public.nhis_duplicate_export_policy_audit from public, anon, authenticated;
grant select on public.organization_nhis_duplicate_export_policy to authenticated;
grant select on public.nhis_duplicate_export_policy_audit to authenticated;

drop policy if exists nhis_duplicate_export_policy_read on public.organization_nhis_duplicate_export_policy;
create policy nhis_duplicate_export_policy_read on public.organization_nhis_duplicate_export_policy
for select to authenticated using (organization_id = public.user_organization_id());

drop policy if exists nhis_duplicate_export_policy_audit_read on public.nhis_duplicate_export_policy_audit;
create policy nhis_duplicate_export_policy_audit_read on public.nhis_duplicate_export_policy_audit
for select to authenticated using (organization_id = public.user_organization_id());

create or replace function public.get_nhis_duplicate_export_policy(p_org uuid)
returns jsonb language plpgsql security definer set search_path=public, pg_catalog as $$
declare value boolean;
begin
  if p_org is distinct from public.user_organization_id() then
    raise exception 'Organization access denied.' using errcode='42501';
  end if;
  select allow_duplicate_exports into value
    from public.organization_nhis_duplicate_export_policy
    where organization_id=p_org;
  return jsonb_build_object('organization_id',p_org,'allow_duplicate_exports',coalesce(value,false));
end $$;

create or replace function public.save_nhis_duplicate_export_policy(p_org uuid, p_allow_duplicate_exports boolean)
returns jsonb language plpgsql security definer set search_path=public, pg_catalog as $$
declare actor public.users%rowtype; previous boolean; next_value boolean := coalesce(p_allow_duplicate_exports,false);
begin
  select * into actor from public.users where id=auth.uid() and organization_id=p_org and is_active=true;
  if not found or coalesce(actor.role,'') not in ('admin','super_admin') then
    raise exception 'Only an organization administrator can change duplicate export policy.' using errcode='42501';
  end if;
  select allow_duplicate_exports into previous from public.organization_nhis_duplicate_export_policy
    where organization_id=p_org for update;
  previous := coalesce(previous,false);
  insert into public.organization_nhis_duplicate_export_policy(organization_id,allow_duplicate_exports,updated_by,updated_at)
    values(p_org,next_value,actor.id,now())
    on conflict (organization_id) do update set allow_duplicate_exports=excluded.allow_duplicate_exports,
      updated_by=excluded.updated_by, updated_at=excluded.updated_at;
  if previous is distinct from next_value then
    insert into public.nhis_duplicate_export_policy_audit(organization_id,actor_id,previous_allow_duplicate_exports,new_allow_duplicate_exports)
      values(p_org,actor.id,previous,next_value);
  end if;
  return jsonb_build_object('organization_id',p_org,'allow_duplicate_exports',next_value);
end $$;

revoke all on function public.get_nhis_duplicate_export_policy(uuid), public.save_nhis_duplicate_export_policy(uuid,boolean) from public, anon;
grant execute on function public.get_nhis_duplicate_export_policy(uuid), public.save_nhis_duplicate_export_policy(uuid,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
