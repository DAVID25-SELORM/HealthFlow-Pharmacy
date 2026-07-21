-- Add reusable NHIS prescriber and prescribing-facility master records.
-- This is additive only: existing claim pricing, CCC, duplicate, submission,
-- tariff, and export logic continue to use the existing snapshot text fields.

create table if not exists public.nhis_prescribing_facilities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  facility_name text not null,
  facility_type text,
  nhia_facility_code text,
  provider_number text,
  ownership_type text,
  address text,
  region text,
  district text,
  town text,
  phone text,
  email text,
  contact_person text,
  status text not null default 'active'
    check (status in ('active', 'inactive', 'unverified')),
  verification_status text not null default 'unverified'
    check (verification_status in ('verified', 'unverified', 'rejected')),
  notes text,
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  sync_status text not null default 'synced',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nhis_prescribers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  full_name text not null,
  title text,
  professional_type text not null default 'Doctor',
  license_number text,
  phone text,
  email text,
  primary_facility_id uuid references public.nhis_prescribing_facilities(id) on delete set null,
  specialty text,
  status text not null default 'active'
    check (status in ('active', 'inactive', 'unverified')),
  verification_status text not null default 'unverified'
    check (verification_status in ('verified', 'unverified', 'rejected')),
  notes text,
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  sync_status text not null default 'synced',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nhis_prescriber_facilities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  prescriber_id uuid not null references public.nhis_prescribers(id) on delete cascade,
  facility_id uuid not null references public.nhis_prescribing_facilities(id) on delete cascade,
  is_primary boolean not null default false,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prescriber_id, facility_id)
);

create unique index if not exists idx_nhis_prescribing_facilities_org_code_active
  on public.nhis_prescribing_facilities (organization_id, lower(nhia_facility_code))
  where nhia_facility_code is not null and status = 'active';

create index if not exists idx_nhis_prescribing_facilities_org_name
  on public.nhis_prescribing_facilities (organization_id, lower(facility_name));

create unique index if not exists idx_nhis_prescribers_org_license_active
  on public.nhis_prescribers (organization_id, lower(license_number))
  where license_number is not null and status = 'active';

create index if not exists idx_nhis_prescribers_org_name
  on public.nhis_prescribers (organization_id, lower(full_name));

create index if not exists idx_nhis_prescriber_facilities_facility
  on public.nhis_prescriber_facilities (facility_id, status);

alter table public.nhis_claims
  add column if not exists prescriber_id uuid references public.nhis_prescribers(id) on delete set null,
  add column if not exists prescribing_facility_id uuid references public.nhis_prescribing_facilities(id) on delete set null,
  add column if not exists prescription_date date,
  add column if not exists prescription_reference text,
  add column if not exists prescriber_name_snapshot text,
  add column if not exists prescriber_license_snapshot text,
  add column if not exists prescribing_facility_name_snapshot text,
  add column if not exists prescribing_facility_code_snapshot text;

create index if not exists idx_nhis_claims_prescriber_id
  on public.nhis_claims (prescriber_id, created_at);

create index if not exists idx_nhis_claims_prescribing_facility_id
  on public.nhis_claims (prescribing_facility_id, created_at);

alter table public.nhis_prescribing_facilities enable row level security;
alter table public.nhis_prescribers enable row level security;
alter table public.nhis_prescriber_facilities enable row level security;

drop policy if exists nhis_prescribing_facilities_select_org on public.nhis_prescribing_facilities;
create policy nhis_prescribing_facilities_select_org
  on public.nhis_prescribing_facilities
  for select
  using (organization_id = public.user_organization_id());

drop policy if exists nhis_prescribing_facilities_write_org on public.nhis_prescribing_facilities;
create policy nhis_prescribing_facilities_write_org
  on public.nhis_prescribing_facilities
  for all
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users
      where id = auth.uid()
        and role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
    )
  )
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users
      where id = auth.uid()
        and role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
    )
  );

drop policy if exists nhis_prescribers_select_org on public.nhis_prescribers;
create policy nhis_prescribers_select_org
  on public.nhis_prescribers
  for select
  using (organization_id = public.user_organization_id());

drop policy if exists nhis_prescribers_write_org on public.nhis_prescribers;
create policy nhis_prescribers_write_org
  on public.nhis_prescribers
  for all
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users
      where id = auth.uid()
        and role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
    )
  )
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users
      where id = auth.uid()
        and role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
    )
  );

drop policy if exists nhis_prescriber_facilities_select_org on public.nhis_prescriber_facilities;
create policy nhis_prescriber_facilities_select_org
  on public.nhis_prescriber_facilities
  for select
  using (organization_id = public.user_organization_id());

drop policy if exists nhis_prescriber_facilities_write_org on public.nhis_prescriber_facilities;
create policy nhis_prescriber_facilities_write_org
  on public.nhis_prescriber_facilities
  for all
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users
      where id = auth.uid()
        and role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
    )
  )
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users
      where id = auth.uid()
        and role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
    )
  );

comment on table public.nhis_prescribers is
  'Reusable NHIS prescriber/doctor records. Claims keep snapshots so historical submissions do not change when this record is edited.';

comment on table public.nhis_prescribing_facilities is
  'Reusable external prescribing facility records for prescriptions dispensed by this organization.';

comment on column public.nhis_claims.prescriber_id is
  'Optional link to the reusable prescriber record used when the claim was created.';
comment on column public.nhis_claims.prescribing_facility_id is
  'Optional link to the reusable prescribing facility record used when the claim was created.';
comment on column public.nhis_claims.prescriber_name_snapshot is
  'Prescriber name copied at claim creation/update for historical accuracy.';
comment on column public.nhis_claims.prescribing_facility_name_snapshot is
  'Prescribing facility name copied at claim creation/update for historical accuracy.';

create or replace function public.branch_sync_upsert_nhis_prescribing_record(
  p_sync_token text,
  p_entity_type text,
  p_local_id uuid,
  p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
set row_security = off
as $$
declare
  v_client public.branch_sync_clients%rowtype;
  v_remote_id uuid;
  v_response jsonb;
begin
  if p_local_id is null then
    raise exception 'Local record ID is required.';
  end if;

  if p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'Invalid offline record payload.';
  end if;

  v_client := public.get_branch_sync_client(p_sync_token);

  if p_entity_type = 'nhis_prescribing_facilities' then
    insert into public.nhis_prescribing_facilities (
      id, organization_id, branch_id, facility_name, facility_type,
      nhia_facility_code, provider_number, ownership_type, address,
      region, district, town, phone, email, contact_person, status,
      verification_status, notes, created_by, updated_by, sync_status,
      created_at, updated_at
    )
    values (
      p_local_id,
      v_client.organization_id,
      v_client.branch_id,
      nullif(btrim(p_record->>'facility_name'), ''),
      nullif(btrim(p_record->>'facility_type'), ''),
      nullif(btrim(p_record->>'nhia_facility_code'), ''),
      nullif(btrim(p_record->>'provider_number'), ''),
      nullif(btrim(p_record->>'ownership_type'), ''),
      nullif(btrim(p_record->>'address'), ''),
      nullif(btrim(p_record->>'region'), ''),
      nullif(btrim(p_record->>'district'), ''),
      nullif(btrim(p_record->>'town'), ''),
      nullif(btrim(p_record->>'phone'), ''),
      nullif(btrim(p_record->>'email'), ''),
      nullif(btrim(p_record->>'contact_person'), ''),
      coalesce(nullif(btrim(p_record->>'status'), ''), 'active'),
      coalesce(nullif(btrim(p_record->>'verification_status'), ''), 'unverified'),
      nullif(btrim(p_record->>'notes'), ''),
      nullif(p_record->>'created_by', '')::uuid,
      nullif(p_record->>'updated_by', '')::uuid,
      'synced',
      coalesce(nullif(p_record->>'created_at', '')::timestamptz, now()),
      coalesce(nullif(p_record->>'updated_at', '')::timestamptz, now())
    )
    on conflict (id) do update set
      facility_name = excluded.facility_name,
      facility_type = excluded.facility_type,
      nhia_facility_code = excluded.nhia_facility_code,
      provider_number = excluded.provider_number,
      ownership_type = excluded.ownership_type,
      address = excluded.address,
      region = excluded.region,
      district = excluded.district,
      town = excluded.town,
      phone = excluded.phone,
      email = excluded.email,
      contact_person = excluded.contact_person,
      status = excluded.status,
      verification_status = excluded.verification_status,
      notes = excluded.notes,
      updated_by = excluded.updated_by,
      sync_status = 'synced',
      updated_at = excluded.updated_at
    returning id into v_remote_id;
  elsif p_entity_type = 'nhis_prescribers' then
    insert into public.nhis_prescribers (
      id, organization_id, branch_id, full_name, title, professional_type,
      license_number, phone, email, primary_facility_id, specialty, status,
      verification_status, notes, created_by, updated_by, sync_status,
      created_at, updated_at
    )
    values (
      p_local_id,
      v_client.organization_id,
      v_client.branch_id,
      nullif(btrim(p_record->>'full_name'), ''),
      nullif(btrim(p_record->>'title'), ''),
      coalesce(nullif(btrim(p_record->>'professional_type'), ''), 'Doctor'),
      nullif(btrim(p_record->>'license_number'), ''),
      nullif(btrim(p_record->>'phone'), ''),
      nullif(btrim(p_record->>'email'), ''),
      nullif(p_record->>'primary_facility_id', '')::uuid,
      nullif(btrim(p_record->>'specialty'), ''),
      coalesce(nullif(btrim(p_record->>'status'), ''), 'active'),
      coalesce(nullif(btrim(p_record->>'verification_status'), ''), 'unverified'),
      nullif(btrim(p_record->>'notes'), ''),
      nullif(p_record->>'created_by', '')::uuid,
      nullif(p_record->>'updated_by', '')::uuid,
      'synced',
      coalesce(nullif(p_record->>'created_at', '')::timestamptz, now()),
      coalesce(nullif(p_record->>'updated_at', '')::timestamptz, now())
    )
    on conflict (id) do update set
      full_name = excluded.full_name,
      title = excluded.title,
      professional_type = excluded.professional_type,
      license_number = excluded.license_number,
      phone = excluded.phone,
      email = excluded.email,
      primary_facility_id = excluded.primary_facility_id,
      specialty = excluded.specialty,
      status = excluded.status,
      verification_status = excluded.verification_status,
      notes = excluded.notes,
      updated_by = excluded.updated_by,
      sync_status = 'synced',
      updated_at = excluded.updated_at
    returning id into v_remote_id;
  else
    raise exception 'Unsupported NHIS prescribing record entity type: %', p_entity_type;
  end if;

  v_response := jsonb_build_object(
    'entity_type', p_entity_type,
    'local_id', p_local_id,
    'remote_id', v_remote_id,
    'branch_id', v_client.branch_id,
    'organization_id', v_client.organization_id
  );

  insert into public.branch_sync_events (
    sync_client_id, event_type, local_id, remote_id, response
  )
  values (
    v_client.id,
    'record.upsert.' || p_entity_type,
    p_local_id,
    v_remote_id,
    v_response
  )
  on conflict (sync_client_id, event_type, local_id) do update set
    remote_id = excluded.remote_id,
    response = excluded.response,
    created_at = now();

  return v_response;
end;
$$;

grant execute on function public.branch_sync_upsert_nhis_prescribing_record(text, text, uuid, jsonb)
  to anon, authenticated;
