create table if not exists public.nhia_configuration (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  mode text not null default 'ONLINE_CLOUD',
  provider_id text,
  credential_code text,
  accreditation_expiry_date date,
  claims_officer_name text,
  api_base_url text,
  submitter_id text,
  api_key_encrypted text,
  api_secret_encrypted text,
  has_api_key boolean not null default false,
  has_api_secret boolean not null default false,
  api_key_header_name text,
  api_secret_header_name text,
  api_key_header_prefix text,
  username text,
  password_encrypted text,
  token_endpoint_path text,
  claim_submit_endpoint text,
  claim_status_endpoint text,
  member_lookup_endpoint text,
  cc_endpoint_path text,
  validation_mode text not null default 'validate_before_submit',
  facility_code text,
  provider_number text,
  scheme_name text not null default 'National Health Insurance',
  facility_type text,
  pharmacy_facility_level text,
  provider_level_code text,
  license_number text,
  integration_mode text not null default 'claimit_export',
  connection_profile text not null default 'local_server',
  claim_control_mode text not null default 'manual',
  sandbox_base_url text,
  production_base_url text,
  provider_type_description text,
  provider_class_level text,
  admission_payment_option text not null default 'nhis_pays_admission',
  claimit_validation_enabled boolean not null default true,
  claims_officer_signature_url text,
  api_environment text not null default 'production',
  claim_endpoint_path text,
  claim_validation_endpoint_path text,
  cc_code_endpoint_path text,
  member_lookup_endpoint_path text,
  claim_status_endpoint_path text,
  direct_api_enabled boolean not null default false,
  credential_mode text not null default 'api_key',
  nhis_member_digits integer not null default 8,
  ghana_card_digits integer not null default 10,
  export_format text not null default 'json',
  max_retry_attempts integer not null default 3,
  is_active boolean not null default true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_nhia_configuration_org_branch
  on public.nhia_configuration (organization_id, branch_id) nulls not distinct;

create index if not exists idx_nhia_configuration_branch
  on public.nhia_configuration (branch_id)
  where branch_id is not null;

alter table public.nhia_configuration enable row level security;

drop policy if exists "nhia_configuration_select_org" on public.nhia_configuration;
create policy "nhia_configuration_select_org"
  on public.nhia_configuration
  for select
  using (
    organization_id = public.user_organization_id()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'super_admin'
    )
  );

drop policy if exists "nhia_configuration_service_write" on public.nhia_configuration;
create policy "nhia_configuration_service_write"
  on public.nhia_configuration
  for all
  using (
    (
      organization_id = public.user_organization_id()
      and exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.role = 'admin'
      )
    )
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'super_admin'
    )
  )
  with check (
    (
      organization_id = public.user_organization_id()
      and exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.role = 'admin'
      )
    )
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'super_admin'
    )
  );

create or replace function public.set_nhia_configuration_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.has_api_key = nullif(new.api_key_encrypted, '') is not null;
  new.has_api_secret = nullif(new.api_secret_encrypted, '') is not null;
  return new;
end;
$$;

drop trigger if exists trg_nhia_configuration_updated_at on public.nhia_configuration;
create trigger trg_nhia_configuration_updated_at
before update on public.nhia_configuration
for each row
execute function public.set_nhia_configuration_updated_at();

create or replace function pg_temp.nhia_column_expr(column_name text, fallback text)
returns text
language plpgsql
as $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_nhia_integrations'
      and columns.column_name = $1
  ) then
    return quote_ident(column_name);
  end if;
  return fallback;
end;
$$;

create or replace function pg_temp.nhia_json_secret(payload text, secret_key text)
returns text
language plpgsql
as $$
declare
  parsed jsonb;
begin
  if payload is null or btrim(payload) = '' then
    return null;
  end if;
  parsed := payload::jsonb;
  return parsed ->> secret_key;
exception when others then
  return null;
end;
$$;

create or replace function pg_temp.nhia_json_expr(column_name text, secret_key text)
returns text
language plpgsql
as $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_nhia_integrations'
      and columns.column_name = $1
  ) then
    return format('pg_temp.nhia_json_secret(%I, %L)', column_name, secret_key);
  end if;
  return 'null::text';
end;
$$;

do $$
declare
  organization_expr text;
  branch_expr text;
  sql text;
begin
  if to_regclass('public.organization_nhia_integrations') is null then
    return;
  end if;

  organization_expr := pg_temp.nhia_column_expr('organization_id', 'null::uuid');
  branch_expr := pg_temp.nhia_column_expr('branch_id', 'null::uuid');

  sql := format($migrate$
    insert into public.nhia_configuration (
      organization_id,
      branch_id,
      provider_id,
      provider_number,
      facility_code,
      credential_code,
      accreditation_expiry_date,
      claims_officer_name,
      api_base_url,
      submitter_id,
      api_key_encrypted,
      api_secret_encrypted,
      has_api_key,
      has_api_secret,
      api_key_header_name,
      api_secret_header_name,
      api_key_header_prefix,
      username,
      password_encrypted,
      token_endpoint_path,
      claim_submit_endpoint,
      claim_endpoint_path,
      claim_status_endpoint,
      claim_status_endpoint_path,
      member_lookup_endpoint,
      member_lookup_endpoint_path,
      cc_endpoint_path,
      cc_code_endpoint_path,
      validation_mode,
      scheme_name,
      facility_type,
      pharmacy_facility_level,
      provider_level_code,
      license_number,
      integration_mode,
      connection_profile,
      claim_control_mode,
      sandbox_base_url,
      production_base_url,
      provider_type_description,
      provider_class_level,
      admission_payment_option,
      claimit_validation_enabled,
      claims_officer_signature_url,
      api_environment,
      claim_validation_endpoint_path,
      direct_api_enabled,
      credential_mode,
      nhis_member_digits,
      ghana_card_digits,
      export_format,
      max_retry_attempts,
      is_active,
      created_by,
      updated_by,
      created_at,
      updated_at
    )
    select
      %1$s,
      %2$s,
      coalesce(%3$s, %4$s),
      coalesce(%4$s, %3$s),
      %5$s,
      coalesce(%6$s, %5$s),
      %7$s,
      %8$s,
      %9$s,
      %10$s,
      %11$s,
      %12$s,
      coalesce(%13$s, nullif(%11$s, '') is not null, false),
      coalesce(%14$s, nullif(%12$s, '') is not null, false),
      %15$s,
      %16$s,
      %17$s,
      %18$s,
      %19$s,
      %20$s,
      %21$s,
      %21$s,
      %22$s,
      %22$s,
      %23$s,
      %23$s,
      %24$s,
      %25$s,
      coalesce(%26$s, 'validate_before_submit'),
      coalesce(%27$s, 'National Health Insurance'),
      %28$s,
      %29$s,
      %30$s,
      %31$s,
      coalesce(%32$s, 'claimit_export'),
      coalesce(%33$s, 'local_server'),
      coalesce(%34$s, 'manual'),
      %35$s,
      %36$s,
      %37$s,
      %38$s,
      coalesce(%39$s, 'nhis_pays_admission'),
      coalesce(%40$s, true),
      %41$s,
      coalesce(%42$s, 'production'),
      %43$s,
      coalesce(%44$s, false),
      coalesce(%45$s, 'api_key'),
      coalesce(%46$s, 8),
      coalesce(%47$s, 10),
      coalesce(%48$s, 'json'),
      coalesce(%49$s, 3),
      coalesce(%50$s, true),
      %51$s,
      %52$s,
      coalesce(%53$s, now()),
      coalesce(%54$s, now())
    from public.organization_nhia_integrations
    where %1$s is not null
    on conflict (organization_id, branch_id) do nothing
  $migrate$,
    organization_expr,
    branch_expr,
    pg_temp.nhia_column_expr('provider_id', 'null::text'),
    pg_temp.nhia_column_expr('provider_number', 'null::text'),
    pg_temp.nhia_column_expr('facility_code', 'null::text'),
    pg_temp.nhia_column_expr('credential_code', 'null::text'),
    pg_temp.nhia_column_expr('accreditation_expiry_date', 'null::date'),
    pg_temp.nhia_column_expr('claims_officer_name', 'null::text'),
    pg_temp.nhia_column_expr('api_base_url', 'null::text'),
    pg_temp.nhia_column_expr('submitter_id', 'null::text'),
    pg_temp.nhia_json_expr('credential_payload', 'apiKey'),
    pg_temp.nhia_json_expr('credential_payload', 'apiSecret'),
    pg_temp.nhia_column_expr('has_api_key', 'null::boolean'),
    pg_temp.nhia_column_expr('has_api_secret', 'null::boolean'),
    pg_temp.nhia_json_expr('credential_payload', 'headerName'),
    pg_temp.nhia_json_expr('credential_payload', 'secretHeaderName'),
    pg_temp.nhia_json_expr('credential_payload', 'headerPrefix'),
    pg_temp.nhia_json_expr('credential_payload', 'username'),
    pg_temp.nhia_json_expr('credential_payload', 'password'),
    pg_temp.nhia_json_expr('credential_payload', 'tokenEndpointPath'),
    pg_temp.nhia_column_expr('claim_endpoint_path', 'null::text'),
    pg_temp.nhia_column_expr('claim_status_endpoint_path', 'null::text'),
    pg_temp.nhia_column_expr('member_lookup_endpoint_path', 'null::text'),
    pg_temp.nhia_column_expr('cc_endpoint_path', 'null::text'),
    pg_temp.nhia_column_expr('cc_code_endpoint_path', 'null::text'),
    pg_temp.nhia_column_expr('validation_mode', 'null::text'),
    pg_temp.nhia_column_expr('scheme_name', 'null::text'),
    pg_temp.nhia_column_expr('facility_type', 'null::text'),
    pg_temp.nhia_column_expr('pharmacy_facility_level', 'null::text'),
    pg_temp.nhia_column_expr('provider_level_code', 'null::text'),
    pg_temp.nhia_column_expr('license_number', 'null::text'),
    pg_temp.nhia_column_expr('integration_mode', 'null::text'),
    pg_temp.nhia_column_expr('connection_profile', 'null::text'),
    pg_temp.nhia_column_expr('claim_control_mode', 'null::text'),
    pg_temp.nhia_column_expr('sandbox_base_url', 'null::text'),
    pg_temp.nhia_column_expr('production_base_url', 'null::text'),
    pg_temp.nhia_column_expr('provider_type_description', 'null::text'),
    pg_temp.nhia_column_expr('provider_class_level', 'null::text'),
    pg_temp.nhia_column_expr('admission_payment_option', 'null::text'),
    pg_temp.nhia_column_expr('claimit_validation_enabled', 'null::boolean'),
    pg_temp.nhia_column_expr('claims_officer_signature_url', 'null::text'),
    pg_temp.nhia_column_expr('api_environment', 'null::text'),
    pg_temp.nhia_column_expr('claim_validation_endpoint_path', 'null::text'),
    pg_temp.nhia_column_expr('direct_api_enabled', 'null::boolean'),
    pg_temp.nhia_column_expr('credential_mode', 'null::text'),
    pg_temp.nhia_column_expr('nhis_member_digits', 'null::integer'),
    pg_temp.nhia_column_expr('ghana_card_digits', 'null::integer'),
    pg_temp.nhia_column_expr('export_format', 'null::text'),
    pg_temp.nhia_column_expr('max_retry_attempts', 'null::integer'),
    pg_temp.nhia_column_expr('is_active', 'null::boolean'),
    pg_temp.nhia_column_expr('created_by', 'null::uuid'),
    pg_temp.nhia_column_expr('updated_by', 'null::uuid'),
    pg_temp.nhia_column_expr('created_at', 'null::timestamptz'),
    pg_temp.nhia_column_expr('updated_at', 'null::timestamptz')
  );

  execute sql;
end;
$$;
