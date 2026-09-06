-- Learn normalized manual NHIS dose entries without exposing encounter, patient,
-- prescriber, staff, branch, or organization data through shared suggestions.

create table if not exists public.nhis_dose_suggestion_settings (
  singleton boolean primary key default true check (singleton),
  min_contributing_organizations integer not null default 2 check (min_contributing_organizations >= 2),
  min_uses_per_organization integer not null default 2 check (min_uses_per_organization >= 1),
  shared_suggestions_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.nhis_dose_suggestion_settings (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.nhis_facility_dose_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  nhis_drug_id uuid not null references public.nhis_drugs(id) on delete restrict,
  dosage_form text not null,
  strength text not null,
  dose_value numeric not null check (dose_value > 0),
  dose_unit text not null,
  usage_count integer not null default 1 check (usage_count > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (organization_id, nhis_drug_id, dosage_form, strength, dose_value, dose_unit)
);

create index if not exists idx_nhis_facility_dose_suggestions_lookup
  on public.nhis_facility_dose_suggestions (organization_id, nhis_drug_id, dosage_form, strength, last_seen_at desc);

-- Stores only a one-way opaque idempotency key, never a claim or patient ID.
create table if not exists public.nhis_dose_suggestion_observation_keys (
  observation_key_hash text primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.nhis_shared_dose_suggestions (
  id uuid primary key default gen_random_uuid(),
  nhis_drug_id uuid not null references public.nhis_drugs(id) on delete restrict,
  dosage_form text not null,
  strength text not null,
  dose_value numeric not null check (dose_value > 0),
  dose_unit text not null,
  anonymous_usage_count integer not null default 0 check (anonymous_usage_count >= 0),
  contributing_org_count integer not null default 0 check (contributing_org_count >= 0),
  status text not null default 'active' check (status in ('active', 'suppressed', 'review_required')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (nhis_drug_id, dosage_form, strength, dose_value, dose_unit)
);

create index if not exists idx_nhis_shared_dose_suggestions_lookup
  on public.nhis_shared_dose_suggestions (nhis_drug_id, dosage_form, strength, status, last_seen_at desc);

alter table public.nhis_dose_suggestion_settings enable row level security;
alter table public.nhis_facility_dose_suggestions enable row level security;
alter table public.nhis_dose_suggestion_observation_keys enable row level security;
alter table public.nhis_shared_dose_suggestions enable row level security;
revoke all on public.nhis_dose_suggestion_settings, public.nhis_facility_dose_suggestions,
  public.nhis_dose_suggestion_observation_keys, public.nhis_shared_dose_suggestions
  from public, anon, authenticated;

create or replace function public.nhis_normalize_dose_suggestion_text(p_value text)
returns text language sql immutable set search_path = pg_catalog as $$
  select nullif(regexp_replace(lower(btrim(coalesce(p_value, ''))), '\\s+', ' ', 'g'), '');
$$;

create or replace function public.record_nhis_dose_suggestions(p_observations jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_org_id uuid := public.user_organization_id();
  v_observation jsonb;
  v_key text;
  v_drug_id uuid;
  v_form text;
  v_strength text;
  v_value numeric;
  v_unit text;
  v_recorded integer := 0;
  v_inserted integer;
begin
  if auth.uid() is null or v_org_id is null then
    raise exception 'Authentication and organization context are required.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.organization_id = v_org_id and u.is_active = true
      and (u.role in ('admin', 'super_admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer')
        or coalesce(u.assigned_roles, '{}'::text[])
          && array['admin', 'super_admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer']::text[])
  ) then
    raise exception 'You do not have permission to learn NHIS dose suggestions.' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_observations, 'null'::jsonb)) <> 'array' then
    raise exception 'Dose observations must be an array.' using errcode = '22023';
  end if;

  for v_observation in select value from jsonb_array_elements(p_observations) loop
    v_key := nullif(btrim(v_observation->>'idempotency_key'), '');
    v_drug_id := nullif(v_observation->>'nhis_drug_id', '')::uuid;
    v_form := public.nhis_normalize_dose_suggestion_text(v_observation->>'dosage_form');
    v_strength := public.nhis_normalize_dose_suggestion_text(v_observation->>'strength');
    v_value := nullif(v_observation->>'dose_value', '')::numeric;
    v_unit := public.nhis_normalize_dose_suggestion_text(v_observation->>'dose_unit');
    if v_key is null or v_drug_id is null or v_form is null or v_strength is null
       or v_value is null or v_value <= 0 or v_unit is null
       or v_unit !~ '^[a-zµ]+$' then
      raise exception 'Invalid normalized learned-dose observation.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.nhis_drugs d where d.id = v_drug_id) then
      raise exception 'NHIS catalogue medicine was not found.' using errcode = '23503';
    end if;

    insert into public.nhis_dose_suggestion_observation_keys (observation_key_hash, organization_id)
    values (md5(v_key), v_org_id)
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then continue; end if;

    insert into public.nhis_facility_dose_suggestions (
      organization_id, nhis_drug_id, dosage_form, strength, dose_value, dose_unit
    ) values (v_org_id, v_drug_id, v_form, v_strength, v_value, v_unit)
    on conflict (organization_id, nhis_drug_id, dosage_form, strength, dose_value, dose_unit)
    do update set usage_count = public.nhis_facility_dose_suggestions.usage_count + 1,
                  last_seen_at = now();
    v_recorded := v_recorded + 1;

    insert into public.nhis_shared_dose_suggestions (
      nhis_drug_id, dosage_form, strength, dose_value, dose_unit,
      anonymous_usage_count, contributing_org_count, first_seen_at, last_seen_at, updated_at
    )
    select f.nhis_drug_id, f.dosage_form, f.strength, f.dose_value, f.dose_unit,
      sum(f.usage_count)::integer, count(*)::integer, min(f.first_seen_at), max(f.last_seen_at), now()
    from public.nhis_facility_dose_suggestions f
    cross join public.nhis_dose_suggestion_settings settings
    where f.nhis_drug_id = v_drug_id and f.dosage_form = v_form and f.strength = v_strength
      and f.dose_value = v_value and f.dose_unit = v_unit
      and settings.shared_suggestions_enabled
      and f.usage_count >= settings.min_uses_per_organization
    group by f.nhis_drug_id, f.dosage_form, f.strength, f.dose_value, f.dose_unit, settings.min_contributing_organizations
    having count(*) >= settings.min_contributing_organizations
    on conflict (nhis_drug_id, dosage_form, strength, dose_value, dose_unit)
    do update set anonymous_usage_count = excluded.anonymous_usage_count,
                  contributing_org_count = excluded.contributing_org_count,
                  last_seen_at = excluded.last_seen_at,
                  updated_at = excluded.updated_at
      where public.nhis_shared_dose_suggestions.status <> 'suppressed';
  end loop;
  return v_recorded;
end;
$$;

create or replace function public.get_nhis_dose_suggestions(
  p_nhis_drug_id uuid, p_dosage_form text, p_strength text
)
returns table (dose_value numeric, dose_unit text, source text, usage_count integer)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_org_id uuid := public.user_organization_id();
  v_form text := public.nhis_normalize_dose_suggestion_text(p_dosage_form);
  v_strength text := public.nhis_normalize_dose_suggestion_text(p_strength);
begin
  if auth.uid() is null or v_org_id is null then
    raise exception 'Authentication and organization context are required.' using errcode = '42501';
  end if;
  return query
  select f.dose_value, f.dose_unit, 'facility'::text, f.usage_count
  from public.nhis_facility_dose_suggestions f
  where f.organization_id = v_org_id and f.nhis_drug_id = p_nhis_drug_id
    and f.dosage_form = v_form and f.strength = v_strength
  union all
  select s.dose_value, s.dose_unit, 'shared'::text, s.anonymous_usage_count
  from public.nhis_shared_dose_suggestions s
  where s.nhis_drug_id = p_nhis_drug_id and s.dosage_form = v_form
    and s.strength = v_strength and s.status = 'active';
end;
$$;

create or replace function public.set_nhis_shared_dose_suggestion_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.is_active = true
      and (u.role = 'super_admin' or 'super_admin' = any(coalesce(u.assigned_roles, '{}'::text[])))
  ) then
    raise exception 'Only a platform Super Admin can manage shared dose suggestions.' using errcode = '42501';
  end if;
  if p_status not in ('active', 'suppressed', 'review_required') then
    raise exception 'Invalid shared dose suggestion status.' using errcode = '22023';
  end if;
  update public.nhis_shared_dose_suggestions set status = p_status, updated_at = now() where id = p_id;
end;
$$;

revoke all on function public.nhis_normalize_dose_suggestion_text(text) from public;
revoke all on function public.record_nhis_dose_suggestions(jsonb),
  public.get_nhis_dose_suggestions(uuid, text, text),
  public.set_nhis_shared_dose_suggestion_status(uuid, text) from public, anon;
grant execute on function public.record_nhis_dose_suggestions(jsonb),
  public.get_nhis_dose_suggestions(uuid, text, text),
  public.set_nhis_shared_dose_suggestion_status(uuid, text) to authenticated;

comment on table public.nhis_shared_dose_suggestions is
  'De-identified convenience suggestions only; popularity is not clinical authority.';
notify pgrst, 'reload schema';
