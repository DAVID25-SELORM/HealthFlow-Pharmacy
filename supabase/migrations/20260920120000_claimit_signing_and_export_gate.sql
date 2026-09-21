-- Additive: served is a dispensing state, not evidence of Claim-IT signing.
-- Existing clinical/financial rows and historical artifacts are never rewritten.
begin;

create table if not exists public.nhis_claim_signatures (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  claim_fingerprint text not null,
  status text not null default 'VALID' check (status = 'VALID'),
  signed_on timestamptz not null default now(),
  signed_by_user_id uuid not null references public.users(id) on delete restrict,
  signed_by_name text not null check (btrim(signed_by_name) <> ''),
  signed_by_role text not null check (btrim(signed_by_role) <> ''),
  reason text not null check (btrim(reason) <> ''),
  unique (claim_id, claim_fingerprint)
);

create table if not exists public.nhis_cxf_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  actor_id uuid not null references public.users(id) on delete restrict,
  event_type text not null,
  reason text,
  signature_id uuid references public.nhis_claim_signatures(id) on delete restrict,
  serializer_version text,
  compatibility_profile text,
  artifact_sha256 text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists nhis_cxf_events_claim_time on public.nhis_cxf_events(claim_id, created_at);

create table if not exists public.nhis_claim_remediation (
  claim_id uuid primary key references public.nhis_claims(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  reasons text[] not null,
  reviewed_at timestamptz not null default now(),
  reviewed_by uuid not null references public.users(id) on delete restrict
);

-- Authorization is derived from the authenticated actor, including assigned roles.
create or replace function public.claimit_actor(p_org uuid)
returns public.users language plpgsql security definer set search_path = public, pg_catalog as $$
declare actor public.users%rowtype;
begin
  select * into actor from public.users where id = auth.uid() and organization_id = p_org and is_active is true;
  if not found or not (coalesce(actor.role,'') in ('admin','claims_officer','pharmacist')
    or coalesce(actor.assigned_roles,'{}') && array['admin','claims_officer','pharmacist']) then
    raise exception 'Claim signing/export access denied.' using errcode = '42501';
  end if;
  return actor;
end $$;

alter table public.nhis_claim_signatures enable row level security;
alter table public.nhis_cxf_events enable row level security;
alter table public.nhis_claim_remediation enable row level security;
revoke all on public.nhis_claim_signatures, public.nhis_cxf_events, public.nhis_claim_remediation from public, anon, authenticated;
grant select on public.nhis_claim_signatures, public.nhis_cxf_events, public.nhis_claim_remediation to authenticated;
-- No INSERT/UPDATE/DELETE policies. Only the checked RPCs can write these tables.
drop policy if exists claimit_signature_read on public.nhis_claim_signatures;
create policy claimit_signature_read on public.nhis_claim_signatures for select to authenticated using (
  exists (select 1 from public.users u where u.id=auth.uid() and u.organization_id=nhis_claim_signatures.organization_id
    and u.is_active and (u.role in ('admin','claims_officer','pharmacist') or coalesce(u.assigned_roles,'{}') && array['admin','claims_officer','pharmacist'])));
drop policy if exists claimit_event_read on public.nhis_cxf_events;
create policy claimit_event_read on public.nhis_cxf_events for select to authenticated using (
  exists (select 1 from public.users u where u.id=auth.uid() and u.organization_id=nhis_cxf_events.organization_id
    and u.is_active and (u.role in ('admin','claims_officer','pharmacist') or coalesce(u.assigned_roles,'{}') && array['admin','claims_officer','pharmacist'])));
drop policy if exists claimit_remediation_read on public.nhis_claim_remediation;
create policy claimit_remediation_read on public.nhis_claim_remediation for select to authenticated using (
  exists (select 1 from public.users u where u.id=auth.uid() and u.organization_id=nhis_claim_remediation.organization_id
    and u.is_active and (u.role in ('admin','claims_officer','pharmacist') or coalesce(u.assigned_roles,'{}') && array['admin','claims_officer','pharmacist'])));

create or replace function public.claimit_snapshot(p_claim uuid)
returns jsonb language sql stable security definer set search_path = public, pg_catalog as $$
  select to_jsonb(c) || jsonb_build_object(
    'nhis_claim_medicines', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.nhis_claim_medicines m where m.claim_id=c.id),'[]'::jsonb),
    'nhis_claim_services', coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from public.nhis_claim_services s where s.claim_id=c.id),'[]'::jsonb)
  ) from public.nhis_claims c where c.id=p_claim
$$;

create or replace function public.claimit_fingerprint(p_snapshot jsonb)
returns text language sql immutable set search_path = public, pg_catalog as $$
  -- Payment/submission timestamps do not change clinical signing evidence.
  select encode(sha256(convert_to((p_snapshot - array['status','updated_at','rejection_reason'])::text,'UTF8')),'hex')
$$;

create or replace function public.claimit_claim_issues(p_snapshot jsonb)
returns text[] language plpgsql stable set search_path = public, pg_catalog as $$
declare issues text[] := '{}'; line jsonb; meds numeric := 0; services numeric := 0;
begin
  if p_snapshot is null then return array['CLAIM_NOT_FOUND']; end if;
  -- Mirror established final-submission blockers; never fill clinical gaps.
  if nullif(btrim(p_snapshot->>'surname'),'') is null then issues:=array_append(issues,'MISSING_PATIENT_SURNAME'); end if;
  if nullif(btrim(p_snapshot->>'folder_no'),'') is null then issues:=array_append(issues,'MISSING_FOLDER_NUMBER'); end if;
  if nullif(btrim(p_snapshot->>'referring_facility'),'') is null then issues:=array_append(issues,'MISSING_PRESCRIBING_FACILITY'); end if;
  if nullif(btrim(p_snapshot->>'physician_name'),'') is null then issues:=array_append(issues,'MISSING_PRESCRIBER'); end if;
  if p_snapshot->'diagnosis_details' is not null and p_snapshot->'diagnosis_details' <> 'null'::jsonb then
    if jsonb_typeof(p_snapshot->'diagnosis_details') <> 'array' then
      issues:=array_append(issues,'INVALID_DIAGNOSIS_STRUCTURE');
    elsif exists(select 1 from jsonb_array_elements(p_snapshot->'diagnosis_details') d
      where jsonb_typeof(d)<>'object' or nullif(btrim(coalesce(d->>'label',d->>'diagnosis',d->>'name')),'') is null) then
      issues:=array_append(issues,'INVALID_DIAGNOSIS_STRUCTURE');
    end if;
  end if;
  if coalesce(p_snapshot->>'status','') not in ('served','fully_served','partially_served','submitted','accepted','approved','paid') then
    issues := array_append(issues,'LIFECYCLE_NOT_READY'); end if;
  if nullif(btrim(p_snapshot->>'ccc_no'),'') is null then issues := array_append(issues,'MISSING_CCC'); end if;
  if regexp_replace(coalesce(p_snapshot->>'ccc_no',''),'[^0-9]','','g') !~ '^[0-9]{5}$' then issues:=array_append(issues,'INVALID_CCC'); end if;
  if coalesce(p_snapshot->>'member_no','') !~ '^[0-9]+$' and coalesce(p_snapshot->>'hin','') !~ '^[0-9]+$' then
    issues := array_append(issues,'INVALID_MEMBER_ID'); end if;
  if nullif(p_snapshot->>'service_date_from','') is null
    or (p_snapshot->>'service_date_from')::date > current_date
    or (p_snapshot->>'service_date_to')::date < (p_snapshot->>'service_date_from')::date then
    issues := array_append(issues,'INVALID_SERVICE_DATES'); end if;
  if jsonb_array_length(p_snapshot->'nhis_claim_medicines') + jsonb_array_length(p_snapshot->'nhis_claim_services') = 0 then
    issues := array_append(issues,'MISSING_BILLABLE_LINES'); end if;
  for line in select value from jsonb_array_elements(p_snapshot->'nhis_claim_medicines') loop
    if nullif(btrim(line->>'drug_code'),'') is null then issues := array_append(issues,'MISSING_MEDICINE_CODE'); end if;
    if nullif(btrim(line->>'dose'),'') is null or nullif(btrim(line->>'frequency'),'') is null then
      issues:=array_append(issues,'MISSING_MEDICINE_INSTRUCTIONS'); end if;
    if nullif(btrim(line->>'duration'),'') is null then issues := array_append(issues,'MISSING_MEDICINE_DURATION'); end if;
    if (line->>'unit_price')::numeric is null or (line->>'dispensed_qty')::numeric is null or (line->>'total_amount')::numeric is null
      or (line->>'unit_price')::numeric < 0 or (line->>'dispensed_qty')::numeric < 0
      or round((line->>'unit_price')::numeric * (line->>'dispensed_qty')::numeric,2) <> (line->>'total_amount')::numeric then
      issues := array_append(issues,'INVALID_MEDICINE_TOTAL'); end if;
    meds := meds + coalesce((line->>'total_amount')::numeric,0);
  end loop;
  for line in select value from jsonb_array_elements(p_snapshot->'nhis_claim_services') loop
    if nullif(btrim(line->>'gdrg_code'),'') is null then issues := array_append(issues,'MISSING_SERVICE_CODE'); end if;
    if (line->>'unit_price')::numeric is null or (line->>'quantity')::numeric is null or (line->>'total_amount')::numeric is null
      or (line->>'unit_price')::numeric < 0 or (line->>'quantity')::numeric <= 0
      or round((line->>'unit_price')::numeric * (line->>'quantity')::numeric,2) <> (line->>'total_amount')::numeric then
      issues := array_append(issues,'INVALID_SERVICE_TOTAL'); end if;
    if coalesce(line->>'tariff_version','') not in ('FEB 2023','2023-02-01.250531') then
      issues := array_append(issues,'UNKNOWN_SERVICE_VERSION'); end if;
    services := services + coalesce((line->>'total_amount')::numeric,0);
  end loop;
  if (p_snapshot->>'total_amount')::numeric is null or meds + services <> (p_snapshot->>'total_amount')::numeric then
    issues := array_append(issues,'INVALID_TOTALS'); end if;
  return array(select distinct unnest(issues) order by 1);
end $$;

create or replace function public.sign_nhis_claim(p_claim_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.nhis_claims%rowtype; actor public.users%rowtype; snap jsonb; issues text[];
  fingerprint text; signature public.nhis_claim_signatures%rowtype; actor_role text;
begin
  select * into c from public.nhis_claims where id=p_claim_id for update;
  if not found then raise exception 'Claim not found or access denied.' using errcode='42501'; end if;
  actor := public.claimit_actor(c.organization_id);
  if nullif(btrim(p_reason),'') is null then raise exception 'A review/signing reason is required.'; end if;
  if nullif(btrim(actor.full_name),'') is null then raise exception 'Signer display name is required on the authenticated account.'; end if;
  snap := public.claimit_snapshot(c.id);
  issues := public.claimit_claim_issues(snap) || public.claimit_context_issues(snap);
  if cardinality(issues)>0 then raise exception 'Claim is not ready to sign: %',array_to_string(issues,', '); end if;
  fingerprint := public.claimit_fingerprint(snap);
  actor_role := case when actor.role in ('admin','claims_officer','pharmacist') then actor.role
    when 'admin'=any(actor.assigned_roles) then 'admin' when 'claims_officer'=any(actor.assigned_roles) then 'claims_officer' else 'pharmacist' end;
  insert into public.nhis_claim_signatures(claim_id,organization_id,claim_fingerprint,signed_by_user_id,signed_by_name,signed_by_role,reason)
  values(c.id,c.organization_id,fingerprint,actor.id,actor.full_name,actor_role,btrim(p_reason))
  on conflict(claim_id,claim_fingerprint) do nothing returning * into signature;
  if found then
    insert into public.nhis_cxf_events(organization_id,claim_id,actor_id,event_type,reason,signature_id)
    values(c.organization_id,c.id,actor.id,'CLAIM_VALIDATED',btrim(p_reason),signature.id),
      (c.organization_id,c.id,actor.id,'CLAIM_SIGNED',btrim(p_reason),signature.id);
  else
    select * into signature from public.nhis_claim_signatures where claim_id=c.id and claim_fingerprint=fingerprint;
  end if;
  return to_jsonb(signature);
end $$;

create or replace function public.claimit_context_issues(p_snapshot jsonb)
returns text[] language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare config jsonb; issues text[]:='{}';
begin
  select to_jsonb(n) into config from public.nhia_configuration n
    where n.organization_id=(p_snapshot->>'organization_id')::uuid and n.is_active
      and (n.branch_id=(p_snapshot->>'branch_id')::uuid or n.branch_id is null)
    order by n.branch_id nulls last,n.updated_at desc limit 1;
  if config is null or nullif(btrim(config->>'credential_code'),'') is null
    or nullif(btrim(coalesce(nullif(config->>'provider_id',''),config->>'provider_number')),'') is null then
    issues:=array_append(issues,'MISSING_PROVIDER_METADATA'); end if;
  if coalesce(config->>'credential_code','') !~ '^[0-9]{2}-[0-9]{2}-[0-9]{3}-[0-9]{2}-[0-9]{5}-[0-9]{2}-[A-Za-z0-9]+-[0-9]-[0-9]{6}$' then
    issues:=array_append(issues,'INVALID_PROVIDER_LEVEL_MAPPING'); end if;
  -- The current serializer only has verified ownership/catering mappings for
  -- 02 => PVT and 2 => CE. Do not silently label another provider as private.
  if split_part(coalesce(config->>'credential_code',''),'-',4)<>'02'
    or split_part(coalesce(config->>'credential_code',''),'-',8)<>'2' then
    issues:=array_append(issues,'UNSUPPORTED_PROVIDER_OWNERSHIP_CATERING'); end if;
  if lower(coalesce(config->>'facility_type','')) not in ('pharmacy','chemical seller','hospital','clinic','maternity','hospital pharmacy') then
    issues:=array_append(issues,'UNKNOWN_FACILITY_TYPE'); end if;
  if lower(config->>'facility_type') in ('hospital','clinic','maternity','hospital pharmacy')
    and nullif(btrim(p_snapshot->>'diagnosis'),'') is null then
    issues:=array_append(issues,'MISSING_HOSPITAL_DIAGNOSIS'); end if;
  if lower(config->>'facility_type') in ('pharmacy','chemical seller')
    and jsonb_array_length(p_snapshot->'nhis_claim_services')>0 then
    issues:=array_append(issues,'PHARMACY_SERVICE_LINES_NOT_ALLOWED'); end if;
  if nullif(config->>'accreditation_date_generated','') is null or nullif(config->>'accreditation_expiry_date','') is null then
    issues:=array_append(issues,'MISSING_ACCREDITATION_DATES');
  elsif (config->>'accreditation_date_generated')::date>current_date
    or (config->>'accreditation_date_generated')::date >= (config->>'accreditation_expiry_date')::date then
    issues:=array_append(issues,'ACCREDITATION_MAPPING_CONFLICT'); end if;
  if lower(coalesce(config->>'facility_type','')) in ('pharmacy','chemical seller') and nullif(p_snapshot->>'prescription_file_path','') is null then
    issues:=array_append(issues,'MISSING_PRESCRIPTION_ATTACHMENT'); end if;
  return issues;
end $$;

-- All line mutations serialize with signing/export checks on the parent lock.
create or replace function public.claimit_lock_parent()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if tg_op='UPDATE' and old.claim_id is distinct from new.claim_id then
    perform id from public.nhis_claims where id in (old.claim_id,new.claim_id) order by id for update;
  else
    perform id from public.nhis_claims where id=case when tg_op='DELETE' then old.claim_id else new.claim_id end for update;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists claimit_lock_parent on public.nhis_claim_medicines;
create trigger claimit_lock_parent before insert or update or delete on public.nhis_claim_medicines for each row execute function public.claimit_lock_parent();
drop trigger if exists claimit_lock_parent on public.nhis_claim_services;
create trigger claimit_lock_parent before insert or update or delete on public.nhis_claim_services for each row execute function public.claimit_lock_parent();

create or replace function public.claimit_export_claims(p_claim_ids uuid[], p_reexport_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.nhis_claims%rowtype; actor public.users%rowtype; snap jsonb; issues text[];
  signature public.nhis_claim_signatures%rowtype; result jsonb := '[]'; config jsonb; count_found integer := 0;
begin
  if coalesce(cardinality(p_claim_ids),0) not between 1 and 500 then raise exception 'Select between 1 and 500 claims per export batch.'; end if;
  if cardinality(p_claim_ids)<>(select count(distinct x) from unnest(p_claim_ids) x) then raise exception 'Duplicate claim IDs.'; end if;
  for c in select * from public.nhis_claims where id=any(p_claim_ids) order by id for update loop
    actor := public.claimit_actor(c.organization_id);
    snap := public.claimit_snapshot(c.id);
    issues := public.claimit_claim_issues(snap) || public.claimit_context_issues(snap);
    select * into signature from public.nhis_claim_signatures where claim_id=c.id and claim_fingerprint=public.claimit_fingerprint(snap);
    if not found then issues:=array_append(issues,'MISSING_OR_STALE_SIGNER'); end if;
    if c.status in ('submitted','accepted','approved','paid') or exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED')) then
      if nullif(btrim(p_reexport_reason),'') is null then issues:=array_append(issues,'REEXPORT_REASON_REQUIRED'); end if;
    end if;
    select to_jsonb(n) into config from public.nhia_configuration n where n.organization_id=c.organization_id and n.is_active
      and (n.branch_id=c.branch_id or n.branch_id is null) order by n.branch_id nulls last, n.updated_at desc limit 1;
    if cardinality(issues)>0 then raise exception 'Claim % is not export-ready: %',c.claim_number,array_to_string(issues,', '); end if;
    result:=result || jsonb_build_array(snap || jsonb_build_object(
      'signed_on',signature.signed_on,'signed_by_user_id',signature.signed_by_user_id,
      'signed_by_name',signature.signed_by_name,'signed_by_role',signature.signed_by_role,
      'claimit_signature_id',signature.id,
      -- Bind export acknowledgement to the provider configuration as well as
      -- the signed clinical revision. A config change requires regeneration.
      'claimit_fingerprint',public.claimit_fingerprint(jsonb_build_object('claim',snap,'config',config)),
      'claimit_export_actor',jsonb_build_object('id',actor.id,'name',actor.full_name,'role',actor.role),
      'claimit_config',jsonb_build_object('credentialCode',config->>'credential_code',
        'providerNumber',coalesce(nullif(config->>'provider_id',''),config->>'provider_number'),
        'accreditationDateGenerated',config->>'accreditation_date_generated','accreditationExpiryDate',config->>'accreditation_expiry_date',
        'facilityType',config->>'facility_type','pharmacyFacilityLevel',config->>'pharmacy_facility_level',
        'organizationType',case when lower(config->>'facility_type') in ('pharmacy','chemical seller') then 'pharmacy' else 'hospital' end,
        'providerTypeDescription',config->>'facility_type',
        'providerClassLevel',config->>'provider_class_level')));
    count_found:=count_found+1;
  end loop;
  if count_found<>cardinality(p_claim_ids) then raise exception 'Claim not found or access denied.' using errcode='42501'; end if;
  return result;
end $$;

create or replace function public.record_nhis_cxf_export(p_claim_ids uuid[], p_fingerprints jsonb, p_artifact_sha256 text, p_reexport_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare claims jsonb; c jsonb; kind text;
begin
  if p_artifact_sha256 !~ '^[0-9a-f]{64}$' or p_artifact_sha256 is null then raise exception 'Artifact SHA-256 required.'; end if;
  claims:=public.claimit_export_claims(p_claim_ids,p_reexport_reason);
  for c in select value from jsonb_array_elements(claims) loop
    if (p_fingerprints->>(c->>'id')) is distinct from (c->>'claimit_fingerprint') then raise exception 'Claim changed during export; regenerate the file.'; end if;
    kind:=case when c->>'status' in ('submitted','accepted','approved','paid') or exists(select 1 from public.nhis_cxf_events where claim_id=(c->>'id')::uuid and event_type in ('CXF_EXPORTED','CXF_REEXPORTED')) then 'CXF_REEXPORTED' else 'CXF_EXPORTED' end;
    insert into public.nhis_cxf_events(organization_id,claim_id,actor_id,event_type,reason,signature_id,serializer_version,compatibility_profile,artifact_sha256)
    values((c->>'organization_id')::uuid,(c->>'id')::uuid,auth.uid(),'CLAIM_EXPORT_VALIDATED',p_reexport_reason,(c->>'claimit_signature_id')::uuid,'claimit-compat-v1','claimit-2025053123',p_artifact_sha256),
      ((c->>'organization_id')::uuid,(c->>'id')::uuid,auth.uid(),kind,p_reexport_reason,(c->>'claimit_signature_id')::uuid,'claimit-compat-v1','claimit-2025053123',p_artifact_sha256);
  end loop;
end $$;

-- Bounded, restartable audit. Dry run is the default. Persist only review reasons;
-- do not infer historical signers from creators/updaters or rewrite submitted totals.
create or replace function public.audit_nhis_claimit(p_after uuid default null, p_limit integer default 100, p_apply boolean default false,
  p_date_from date default null, p_date_to date default null, p_status text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare actor public.users%rowtype; c public.nhis_claims%rowtype; snap jsonb; issues text[]; rows jsonb:='[]';
  grouped jsonb:='{}'; issue text; scanned integer:=0; flagged integer:=0; changed integer:=0; last_id uuid;
  repairable integer:=0; can_repair boolean;
begin
  select * into actor from public.users where id=auth.uid();
  actor:=public.claimit_actor(actor.organization_id);
  if p_apply and not (coalesce(actor.role,'') in ('admin','claims_officer') or coalesce(actor.assigned_roles,'{}') && array['admin','claims_officer']) then
    raise exception 'Only Admin or Claims Officer can apply legacy remediation.' using errcode='42501'; end if;
  for c in select * from public.nhis_claims where organization_id=actor.organization_id
    and (p_after is null or id>p_after) and (p_date_from is null or service_date_from>=p_date_from)
    and (p_date_to is null or service_date_from<=p_date_to) and (p_status is null or status=p_status)
    order by id limit greatest(1,least(coalesce(p_limit,100),500)) loop
    snap:=public.claimit_snapshot(c.id); issues:=public.claimit_claim_issues(snap) || public.claimit_context_issues(snap);
    if not exists(select 1 from public.nhis_claim_signatures where claim_id=c.id and claim_fingerprint=public.claimit_fingerprint(snap)) then
      issues:=array_append(issues,'LEGACY_MISSING_SIGNER'); end if;
    if c.status in ('submitted','accepted','approved','paid') and not exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED')) then
      issues:=array_append(issues,'LEGACY_EXPORT_HISTORY_REVIEW_REQUIRED'); end if;
    can_repair := 'INVALID_TOTALS'=any(issues)
      and not (issues && array['INVALID_MEDICINE_TOTAL','INVALID_SERVICE_TOTAL','MISSING_BILLABLE_LINES'])
      and c.status in ('draft','pending','served','fully_served','partially_served')
      and exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type='CLAIM_CREATED')
      and not exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED'))
      and not exists(select 1 from public.nhis_claim_payments where nhis_claim_id=c.id);
    if can_repair then repairable:=repairable+1; end if;
    foreach issue in array issues loop grouped:=jsonb_set(grouped,array[issue],to_jsonb(coalesce((grouped->>issue)::integer,0)+1)); end loop;
    if cardinality(issues)>0 then flagged:=flagged+1; end if;
    if p_apply then
      insert into public.nhis_claim_remediation(claim_id,organization_id,reasons,reviewed_by)
      values(c.id,c.organization_id,issues,actor.id) on conflict(claim_id) do update
        set reasons=excluded.reasons,reviewed_at=now(),reviewed_by=excluded.reviewed_by
        where nhis_claim_remediation.reasons is distinct from excluded.reasons;
      if found then
        changed:=changed+1;
        insert into public.nhis_cxf_events(organization_id,claim_id,actor_id,event_type,reason)
        values(c.organization_id,c.id,actor.id,'CLAIM_REMEDIATION_REVIEWED',array_to_string(issues,', '));
      end if;
    end if;
    rows:=rows || jsonb_build_array(jsonb_build_object('id',c.id,'claimNumber',c.claim_number,'status',c.status,'issues',issues,
      'fingerprint',public.claimit_fingerprint(snap),'repairable',can_repair,
      'hasRecordedExport',exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED'))));
    scanned:=scanned+1; last_id:=c.id;
  end loop;
  return jsonb_build_object('scanned',scanned,'would_update',repairable,'repairable',repairable,'would_flag',flagged,'automatically_repaired',0,
    'unchanged',scanned-flagged,'manual_review_required',flagged,'flags_written',changed,'errors',0,'counts',grouped,'rows',rows,'next_cursor',last_id);
end $$;

-- A narrowly scoped deterministic backfill. Requires the fingerprint returned by
-- a prior dry-run, rechecks every authoritative line, and never touches exports,
-- submission/payment evidence, prices, quantities, or signer identity.
create or replace function public.repair_nhis_claimit_total(p_claim_id uuid, p_expected_fingerprint text)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare c public.nhis_claims%rowtype; actor public.users%rowtype; snap jsonb; issues text[]; expected numeric;
begin
  select * into c from public.nhis_claims where id=p_claim_id for update;
  if not found then raise exception 'Claim not found or access denied.' using errcode='42501'; end if;
  actor:=public.claimit_actor(c.organization_id);
  if not (coalesce(actor.role,'') in ('admin','claims_officer') or coalesce(actor.assigned_roles,'{}') && array['admin','claims_officer']) then
    raise exception 'Only Admin or Claims Officer can repair totals.' using errcode='42501'; end if;
  snap:=public.claimit_snapshot(c.id);
  if public.claimit_fingerprint(snap) is distinct from p_expected_fingerprint then raise exception 'Preview is stale. Run the dry-run audit again.'; end if;
  if c.status not in ('draft','pending','served','fully_served','partially_served')
    or exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED'))
    or exists(select 1 from public.nhis_claim_payments where nhis_claim_id=c.id) then
    raise exception 'Historical/submitted/paid claims require manual financial review.'; end if;
  -- Legacy exports were not recorded. Require positive evidence that this claim
  -- was created under this lifecycle, not merely absence of an export event.
  if not exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type='CLAIM_CREATED') then
    raise exception 'Legacy export history is unknown; manual financial review required.'; end if;
  issues:=public.claimit_claim_issues(snap);
  if issues && array['INVALID_MEDICINE_TOTAL','INVALID_SERVICE_TOTAL','MISSING_BILLABLE_LINES'] then
    raise exception 'Underlying line totals are not authoritative; manual review required.'; end if;
  select coalesce(sum((line->>'total_amount')::numeric),0) into expected
    from jsonb_array_elements((snap->'nhis_claim_medicines') || (snap->'nhis_claim_services')) line;
  if c.total_amount is distinct from expected then
    update public.nhis_claims set total_amount=expected,updated_at=now() where id=c.id;
    insert into public.nhis_cxf_events(organization_id,claim_id,actor_id,event_type,reason,details)
      values(c.organization_id,c.id,actor.id,'CLAIM_REPAIRED','Header total recomputed from validated stored line totals',
        jsonb_build_object('field','total_amount','previous',c.total_amount,'corrected',expected,'source','nhis_claim_medicines + nhis_claim_services'));
  end if;
  return jsonb_build_object('claim_id',c.id,'previous',c.total_amount,'corrected',expected,'changed',c.total_amount is distinct from expected);
end $$;

create or replace function public.claimit_record_claim_creation()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  -- Sync/service-role writes without an authenticated human are deliberately
  -- not treated as proof of a newly created, never-exported claim.
  if exists(select 1 from public.users where id=auth.uid() and organization_id=new.organization_id and is_active) then
    insert into public.nhis_cxf_events(organization_id,claim_id,actor_id,event_type)
      values(new.organization_id,new.id,auth.uid(),'CLAIM_CREATED');
  end if;
  return new;
end $$;
drop trigger if exists claimit_record_claim_creation on public.nhis_claims;
create trigger claimit_record_claim_creation after insert on public.nhis_claims for each row execute function public.claimit_record_claim_creation();

create or replace function public.claimit_guard_submission()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare snap jsonb;
begin
  if new.status in ('submitted','accepted','approved','paid') and (tg_op='INSERT' or old.status is distinct from new.status) then
    if tg_op='INSERT' then raise exception 'Create and sign a claim before submission.'; end if;
    if (new.status='submitted' and old.status not in ('served','fully_served','partially_served','rejected','failed'))
      or (new.status in ('accepted','approved') and old.status not in ('submitted','accepted','approved'))
      or (new.status='paid' and old.status not in ('served','fully_served','partially_served','submitted','accepted','approved')) then
      raise exception 'Invalid claim lifecycle transition: % to %',old.status,new.status;
    end if;
    perform public.claimit_actor(new.organization_id);
    snap:=public.claimit_snapshot(new.id) || to_jsonb(new);
    if not exists(select 1 from public.nhis_claim_signatures where claim_id=new.id and claim_fingerprint=public.claimit_fingerprint(snap)) then
      raise exception 'Review and sign the current claim before submission or settlement.';
    end if;
    insert into public.nhis_cxf_events(organization_id,claim_id,actor_id,event_type,details)
      values(new.organization_id,new.id,auth.uid(),case when new.status='submitted' then 'CLAIM_SUBMITTED' else 'CLAIM_UPDATED' end,
        jsonb_build_object('old_status',old.status,'new_status',new.status));
  end if;
  return new;
end $$;
drop trigger if exists claimit_guard_submission on public.nhis_claims;
create trigger claimit_guard_submission before insert or update on public.nhis_claims for each row execute function public.claimit_guard_submission();

revoke all on function public.claimit_actor(uuid), public.claimit_snapshot(uuid), public.claimit_fingerprint(jsonb), public.claimit_claim_issues(jsonb), public.claimit_lock_parent() from public,anon,authenticated;
revoke all on function public.claimit_context_issues(jsonb) from public,anon,authenticated;
revoke all on function public.claimit_record_claim_creation() from public,anon,authenticated;
revoke all on function public.claimit_guard_submission() from public,anon,authenticated;
revoke all on function public.repair_nhis_claimit_total(uuid,text) from public,anon;
grant execute on function public.repair_nhis_claimit_total(uuid,text) to authenticated;
revoke all on function public.sign_nhis_claim(uuid,text), public.claimit_export_claims(uuid[],text), public.record_nhis_cxf_export(uuid[],jsonb,text,text), public.audit_nhis_claimit(uuid,integer,boolean,date,date,text) from public,anon;
grant execute on function public.sign_nhis_claim(uuid,text), public.claimit_export_claims(uuid[],text), public.record_nhis_cxf_export(uuid[],jsonb,text,text), public.audit_nhis_claimit(uuid,integer,boolean,date,date,text) to authenticated;
notify pgrst,'reload schema';
commit;
