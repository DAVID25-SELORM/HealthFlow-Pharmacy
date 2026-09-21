-- Claim-IT legacy-compatibility correction (forward migration).
--
-- Evidence: the successful West Point June 2026 HealthFlow export (1,227 claims,
-- accepted by Claim-IT) carried null signer fields on every claim, so signing is a
-- HealthFlow audit feature and NOT a Claim-IT compatibility requirement. The
-- signing/export gate from 20260920120000 therefore must not block legacy claims.
--
-- This migration only redefines functions (no data is changed, nothing is
-- backfilled, no signer is ever derived from creators/updaters/administrators):
--   * claimit_export_claims: readiness findings, a missing signature and a missing
--     re-export reason become warnings (LEGACY_UNSIGNED_CLAIM, ...); authorization
--     and batch-shape errors still raise. Genuine stored signatures are returned.
--   * claimit_guard_submission: audit-only; no longer rejects submitted/accepted/
--     approved/paid transitions or inserts for unsigned claims.
--   * claimit_context_issues / audit_nhis_claimit: accreditation dates that look
--     wrong are reported as ACCREDITATION_DATE_REVIEW_REQUIRED (warning) instead of
--     a blocking ACCREDITATION_MAPPING_CONFLICT. The stored date is never rewritten.
--   * sign_nhis_claim: unchanged behavior except review-only accreditation findings
--     do not prevent an authenticated review.
-- Apply only through the normal, explicitly authorized deployment workflow.
begin;

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
    -- Suspicious, not proven wrong: the stored value is never overwritten and it has
    -- not been shown to prevent a Claim-IT import. Review only; never blocks export.
    issues:=array_append(issues,'ACCREDITATION_DATE_REVIEW_REQUIRED'); end if;
  if lower(coalesce(config->>'facility_type','')) in ('pharmacy','chemical seller') and nullif(p_snapshot->>'prescription_file_path','') is null then
    issues:=array_append(issues,'MISSING_PRESCRIPTION_ATTACHMENT'); end if;
  return issues;
end $$;

create or replace function public.claimit_export_claims(p_claim_ids uuid[], p_reexport_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
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
  -- Review-only accreditation findings do not prevent an authenticated review.
  issues := array(select i from unnest(public.claimit_claim_issues(snap) || public.claimit_context_issues(snap)) i where i <> 'ACCREDITATION_DATE_REVIEW_REQUIRED');
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

create or replace function public.audit_nhis_claimit(p_after uuid default null, p_limit integer default 100, p_apply boolean default false,
  p_date_from date default null, p_date_to date default null, p_status text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare actor public.users%rowtype; c public.nhis_claims%rowtype; snap jsonb; issues text[]; rows jsonb:='[]';
  grouped jsonb:='{}'; issue text; scanned integer:=0; flagged integer:=0; changed integer:=0; last_id uuid;
  repairable integer:=0; can_repair boolean; warns text[]; warn_grouped jsonb:='{}'; warned integer:=0;
begin
  select * into actor from public.users where id=auth.uid();
  actor:=public.claimit_actor(actor.organization_id);
  if p_apply and not (coalesce(actor.role,'') in ('admin','claims_officer') or coalesce(actor.assigned_roles,'{}') && array['admin','claims_officer']) then
    raise exception 'Only Admin or Claims Officer can apply legacy remediation.' using errcode='42501'; end if;
  for c in select * from public.nhis_claims where organization_id=actor.organization_id
    and (p_after is null or id>p_after) and (p_date_from is null or service_date_from>=p_date_from)
    and (p_date_to is null or service_date_from<=p_date_to) and (p_status is null or status=p_status)
    order by id limit greatest(1,least(coalesce(p_limit,100),500)) loop
    warns:='{}';
    snap:=public.claimit_snapshot(c.id); issues:=public.claimit_claim_issues(snap) || public.claimit_context_issues(snap);
    -- Warnings are audit conditions that never block export and are never auto-repaired.
    if 'ACCREDITATION_DATE_REVIEW_REQUIRED'=any(issues) then
      warns:=array_append(warns,'ACCREDITATION_DATE_REVIEW_REQUIRED');
      issues:=array_remove(issues,'ACCREDITATION_DATE_REVIEW_REQUIRED'); end if;
    if not exists(select 1 from public.nhis_claim_signatures where claim_id=c.id and claim_fingerprint=public.claimit_fingerprint(snap)) then
      warns:=array_append(coalesce(warns,'{}'),'LEGACY_UNSIGNED_CLAIM'); end if;
    if c.status in ('submitted','accepted','approved','paid') and not exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED')) then
      warns:=array_append(coalesce(warns,'{}'),'LEGACY_EXPORT_HISTORY_REVIEW_REQUIRED'); end if;
    can_repair := 'INVALID_TOTALS'=any(issues)
      and not (issues && array['INVALID_MEDICINE_TOTAL','INVALID_SERVICE_TOTAL','MISSING_BILLABLE_LINES'])
      and c.status in ('draft','pending','served','fully_served','partially_served')
      and exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type='CLAIM_CREATED')
      and not exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED'))
      and not exists(select 1 from public.nhis_claim_payments where nhis_claim_id=c.id);
    if can_repair then repairable:=repairable+1; end if;
    foreach issue in array warns loop warn_grouped:=jsonb_set(warn_grouped,array[issue],to_jsonb(coalesce((warn_grouped->>issue)::integer,0)+1)); end loop;
    if cardinality(warns)>0 then warned:=warned+1; end if;
    foreach issue in array issues loop grouped:=jsonb_set(grouped,array[issue],to_jsonb(coalesce((grouped->>issue)::integer,0)+1)); end loop;
    if cardinality(issues)>0 then flagged:=flagged+1; end if;
    if p_apply and cardinality(issues)>0 then
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
    rows:=rows || jsonb_build_array(jsonb_build_object('id',c.id,'claimNumber',c.claim_number,'status',c.status,'issues',issues,'warnings',warns,
      'fingerprint',public.claimit_fingerprint(snap),'repairable',can_repair,
      'hasRecordedExport',exists(select 1 from public.nhis_cxf_events where claim_id=c.id and event_type in ('CXF_EXPORTED','CXF_REEXPORTED'))));
    scanned:=scanned+1; last_id:=c.id;
  end loop;
  return jsonb_build_object('scanned',scanned,'would_update',repairable,'repairable',repairable,'would_flag',flagged,'automatically_repaired',0,
    'unchanged',scanned-flagged,'manual_review_required',flagged,'flags_written',changed,'errors',0,'would_warn',warned,'warning_counts',warn_grouped,'counts',grouped,'rows',rows,'next_cursor',last_id);
end $$;

create or replace function public.claimit_guard_submission()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare actor_id uuid;
begin
  -- Audit only. The accepted June export path submitted and settled claims that
  -- carried no signing record, so status transitions must not require one and
  -- must not be rejected. Signing remains an opt-in HealthFlow audit feature.
  if tg_op='UPDATE' and new.status in ('submitted','accepted','approved','paid') and old.status is distinct from new.status then
    select id into actor_id from public.users where id=auth.uid() and organization_id=new.organization_id;
    if actor_id is not null then
      insert into public.nhis_cxf_events(organization_id,claim_id,actor_id,event_type,details)
        values(new.organization_id,new.id,actor_id,case when new.status='submitted' then 'CLAIM_SUBMITTED' else 'CLAIM_UPDATED' end,
          jsonb_build_object('old_status',old.status,'new_status',new.status,
            'has_signature_history',exists(select 1 from public.nhis_claim_signatures where claim_id=new.id)));
    end if;
  end if;
  return new;
end $$;

notify pgrst,'reload schema';
commit;
