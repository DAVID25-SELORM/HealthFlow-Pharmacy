-- Production definitions captured read-only from project bcvmiwmhtvtqrvzdovin on 2026-09-25 (pg_get_functiondef).
-- These functions exist in production but their migrations live only on branch codex/claimit-local-rollout, not on main.
-- The reliability migration is tested against this exact baseline.
CREATE OR REPLACE FUNCTION public.claimit_snapshot(p_claim uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select to_jsonb(c) || jsonb_build_object(
    'nhis_claim_medicines', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.nhis_claim_medicines m where m.claim_id=c.id),'[]'::jsonb),
    'nhis_claim_services', coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from public.nhis_claim_services s where s.claim_id=c.id),'[]'::jsonb)
  ) from public.nhis_claims c where c.id=p_claim
$function$
;

CREATE OR REPLACE FUNCTION public.claimit_claim_issues(p_snapshot jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.claimit_context_issues(p_snapshot jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
    -- Suspicious, not proven wrong: the stored value is never overwritten and it has
    -- not been shown to prevent a Claim-IT import. Review only; never blocks export.
    issues:=array_append(issues,'ACCREDITATION_DATE_REVIEW_REQUIRED'); end if;
  if lower(coalesce(config->>'facility_type','')) in ('pharmacy','chemical seller') and nullif(p_snapshot->>'prescription_file_path','') is null then
    issues:=array_append(issues,'MISSING_PRESCRIPTION_ATTACHMENT'); end if;
  return issues;
end $function$
;

CREATE OR REPLACE FUNCTION public.claimit_actor(p_org uuid)
 RETURNS users
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare actor public.users%rowtype;
begin
  select * into actor from public.users where id = auth.uid() and organization_id = p_org and is_active is true;
  if not found or not (coalesce(actor.role,'') in ('admin','claims_officer','pharmacist')
    or coalesce(actor.assigned_roles,'{}') && array['admin','claims_officer','pharmacist']) then
    raise exception 'Claim signing/export access denied.' using errcode = '42501';
  end if;
  return actor;
end $function$
;

CREATE OR REPLACE FUNCTION public.claimit_fingerprint(p_snapshot jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  -- Payment/submission timestamps do not change clinical signing evidence.
  select encode(sha256(convert_to((p_snapshot - array['status','updated_at','rejection_reason'])::text,'UTF8')),'hex')
$function$
;

CREATE OR REPLACE FUNCTION public.claimit_export_claims(p_claim_ids uuid[], p_reexport_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare c public.nhis_claims%rowtype; actor public.users%rowtype; snap jsonb; warnings text[];
  signature public.nhis_claim_signatures%rowtype; result jsonb := '[]'; config jsonb; count_found integer := 0;
begin
  if coalesce(cardinality(p_claim_ids),0) not between 1 and 500 then raise exception 'Select between 1 and 500 claims per export batch.'; end if;
  if cardinality(p_claim_ids)<>(select count(distinct x) from unnest(p_claim_ids) x) then raise exception 'Duplicate claim IDs.'; end if;
  for c in select * from public.nhis_claims where id=any(p_claim_ids) order by id for update loop
    actor := public.claimit_actor(c.organization_id);
    snap := public.claimit_snapshot(c.id);
    warnings := public.claimit_claim_issues(snap) || public.claimit_context_issues(snap);
    select * into signature from public.nhis_claim_signatures where claim_id=c.id and claim_fingerprint=public.claimit_fingerprint(snap);
    -- Claim-IT does not require signers (the accepted June export had none), so a
    -- missing/stale signature is reported, never enforced. No signer is invented.
    if not found then warnings:=array_append(warnings,'LEGACY_UNSIGNED_CLAIM'); end if;
    if c.status in ('submitted','accepted','approved','paid') or exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED')) then
      if nullif(btrim(p_reexport_reason),'') is null then warnings:=array_append(warnings,'REEXPORT_WITHOUT_REASON'); end if;
    end if;
    select to_jsonb(n) into config from public.nhia_configuration n where n.organization_id=c.organization_id and n.is_active
      and (n.branch_id=c.branch_id or n.branch_id is null) order by n.branch_id nulls last, n.updated_at desc limit 1;
    result:=result || jsonb_build_array(snap || jsonb_build_object(
      'signed_on',signature.signed_on,'signed_by_user_id',signature.signed_by_user_id,
      'signed_by_name',signature.signed_by_name,'signed_by_role',signature.signed_by_role,
      'claimit_signature_id',signature.id,
      'claimit_warnings',to_jsonb(array(select distinct w from unnest(warnings) w order by 1)),
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
end $function$
;

CREATE OR REPLACE FUNCTION public.record_nhis_cxf_export(p_claim_ids uuid[], p_fingerprints jsonb, p_artifact_sha256 text, p_reexport_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.record_nhis_cxf_export_atomic(p_claim_ids uuid[], p_fingerprints jsonb, p_artifact_sha256 text, p_reexport_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare sorted_ids uuid[]; offset_index integer;
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  if coalesce(cardinality(p_claim_ids),0) not between 1 and 10000 then
    raise exception 'Select between 1 and 10000 claims per artifact.';
  end if;
  select array_agg(id order by id) into sorted_ids from unnest(p_claim_ids) id;
  if cardinality(sorted_ids) <> (select count(distinct id) from unnest(sorted_ids) id) then
    raise exception 'Duplicate or null claim IDs.';
  end if;
  if jsonb_typeof(p_fingerprints) is distinct from 'object' then
    raise exception 'Expected claim fingerprints are required.';
  end if;
  -- Global ordering prevents overlapping artifact calls locking chunks in
  -- opposite order. Existing inner RPC checks authorization and readiness.
  offset_index:=1;
  while offset_index<=cardinality(sorted_ids) loop
    perform public.record_nhis_cxf_export(sorted_ids[offset_index:offset_index+499],
      p_fingerprints,p_artifact_sha256,p_reexport_reason);
    offset_index:=offset_index+500;
  end loop;
end $function$
;

