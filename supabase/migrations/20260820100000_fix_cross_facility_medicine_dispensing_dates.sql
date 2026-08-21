-- Correct the clinical calendar date used by the cross-facility active-medicine
-- checks without changing overlap, coverage, duration, pricing, export, or CLAIM-it rules.
--
-- Authoritative order:
--   medicine.dispensary_date
--   Africa/Accra calendar date of medicine.served_at
--   claim.service_date_from
-- Record creation, update, and synchronization timestamps are never clinical fallbacks.

create or replace function public.nhis_medicine_dispensing_date(
  p_dispensary_date date,
  p_served_at timestamptz,
  p_service_date date
)
returns date
language sql
immutable
set search_path = public
as $$
  select coalesce(
    p_dispensary_date,
    (p_served_at at time zone 'Africa/Accra')::date,
    p_service_date
  );
$$;

create or replace function public.nhis_medicine_date_quality_warning(
  p_dispensary_date date,
  p_served_at timestamptz,
  p_service_date date
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_dispensary_date is not null
      and p_served_at is not null
      and p_dispensary_date <> (p_served_at at time zone 'Africa/Accra')::date
      then 'dispensing_date_mismatch'
    when public.nhis_medicine_dispensing_date(p_dispensary_date, p_served_at, p_service_date) is null
      then 'missing_clinical_dispensing_date'
    else null
  end;
$$;

revoke all on function public.nhis_medicine_dispensing_date(date, timestamptz, date) from public;
revoke all on function public.nhis_medicine_date_quality_warning(date, timestamptz, date) from public;
grant execute on function public.nhis_medicine_dispensing_date(date, timestamptz, date) to authenticated;
grant execute on function public.nhis_medicine_date_quality_warning(date, timestamptz, date) to authenticated;

do $$
declare
  v_overlap_signature regprocedure :=
    'public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)'::regprocedure;
  v_batch_signature regprocedure :=
    'public.check_nhis_active_medication_overlap_batch(jsonb)'::regprocedure;
  v_summary_signature regprocedure :=
    'public.get_nhis_patient_active_medications(text,text,date,uuid,uuid)'::regprocedure;
  v_overlap text;
  v_batch text;
  v_summary text;
begin
  select pg_get_functiondef(v_overlap_signature) into v_overlap;
  select pg_get_functiondef(v_batch_signature) into v_batch;
  select pg_get_functiondef(v_summary_signature) into v_summary;

  -- The batch wrapper depends on the scalar overlap function, so preserve its
  -- definition while the scalar return row gains date_quality_warning.
  drop function public.check_nhis_active_medication_overlap_batch(jsonb);

  -- Scalar overlap: add a structured warning, use the controlled clinical-date
  -- helper everywhere, derive the caller tenant server-side, and expose only the
  -- source organisation's display name (never its claim reference).
  v_overlap := replace(
    v_overlap,
    'calculated_treatment_days numeric)',
    E'calculated_treatment_days numeric,\n    date_quality_warning text)'
  );
  v_overlap := replace(
    v_overlap,
    'v_requested_quantity numeric := nullif(p_requested_quantity, 0);',
    E'v_requested_quantity numeric := nullif(p_requested_quantity, 0);\n  v_caller_organization_id uuid;'
  );
  v_overlap := replace(
    v_overlap,
    E'if auth.uid() is null then\n    raise exception ''Authentication is required.'';\n  end if;',
    E'if auth.uid() is null then\n    raise exception ''Authentication is required.'';\n  end if;\n\n  select u.organization_id into v_caller_organization_id\n  from public.users u\n  where u.id = auth.uid() and u.is_active = true;\n\n  if v_caller_organization_id is null then\n    raise exception ''Active organization membership is required.'' using errcode = ''42501'';\n  end if;'
  );
  v_overlap := replace(v_overlap, 'c.claim_number,', E'c.claim_number,\n      o.name as facility_display_name,');
  v_overlap := replace(
    v_overlap,
    'coalesce(m.dispensary_date, c.service_date_from, c.created_at::date) as dispensed_date,',
    E'public.nhis_medicine_dispensing_date(m.dispensary_date, m.served_at, c.service_date_from) as dispensed_date,\n      public.nhis_medicine_date_quality_warning(m.dispensary_date, m.served_at, c.service_date_from) as date_quality_warning,'
  );
  v_overlap := replace(
    v_overlap,
    'join public.nhis_claim_medicines m on m.claim_id = c.id',
    E'join public.nhis_claim_medicines m on m.claim_id = c.id\n    join public.organizations o on o.id = c.organization_id'
  );
  v_overlap := replace(
    v_overlap,
    'coalesce(m.dispensary_date, c.service_date_from, c.created_at::date) <= v_service_date',
    E'(public.nhis_medicine_dispensing_date(m.dispensary_date, m.served_at, c.service_date_from) is null\n        or public.nhis_medicine_dispensing_date(m.dispensary_date, m.served_at, c.service_date_from) <= v_service_date)'
  );
  v_overlap := replace(
    v_overlap,
    'and (matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date >= v_service_date',
    E'and (matched_lines.dispensed_date is null\n        or (matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date >= v_service_date)'
  );
  v_overlap := replace(v_overlap, 'p_current_organization_id is not null and active_matches.organization_id <> p_current_organization_id', 'active_matches.organization_id <> v_caller_organization_id');
  v_overlap := replace(v_overlap, 'p_current_organization_id is not null and scored_matches.organization_id = p_current_organization_id', 'scored_matches.organization_id = v_caller_organization_id');
  v_overlap := replace(v_overlap, 'p_current_organization_id is not null and scored_matches.organization_id <> p_current_organization_id', 'scored_matches.organization_id <> v_caller_organization_id');
  v_overlap := replace(
    v_overlap,
    E'then ''This HealthFlow facility''\n      else ''Another participating HealthFlow facility''',
    E'then ''This HealthFlow facility''\n      else scored_matches.facility_display_name'
  );
  v_overlap := replace(
    v_overlap,
    'case when scored_matches.overlap_match_type = ''exact_code'' then ''Same medicine was served recently.'' else ''Similar active ingredient was served recently.'' end,',
    E'case when scored_matches.date_quality_warning is not null then ''Dispensing date requires review.'' else null end,\n      case when scored_matches.overlap_match_type = ''exact_code'' then ''Same medicine was served recently.'' else ''Similar active ingredient was served recently.'' end,'
  );
  v_overlap := replace(
    v_overlap,
    'round(scored_matches.treatment_days_supplied, 2)::numeric as calculated_treatment_days',
    E'round(scored_matches.treatment_days_supplied, 2)::numeric as calculated_treatment_days,\n    scored_matches.date_quality_warning::text as date_quality_warning'
  );

  if v_overlap not like '%nhis_medicine_dispensing_date%'
     or v_overlap not like '%v_caller_organization_id%'
     or v_overlap not like '%date_quality_warning::text%' then
    raise exception 'Unexpected active-medication overlap definition; safe date patch was not applied';
  end if;

  drop function public.check_nhis_active_medication_overlap(
    text, text, text, date, uuid, uuid, text, text, text, numeric, text, text, text
  );
  execute v_overlap;

  -- Recreate the batch wrapper with its existing public result contract. The
  -- added scalar warning is intentionally not needed by CLAIM-it scrub output.
  execute v_batch;

  -- Patient summary: the same clinical-date and caller-tenant rules. Its
  -- match_identity field remains patient matching data, so append one structured
  -- return column rather than overloading medicine or facility text.
  v_summary := replace(
    v_summary,
    'match_identity text)',
    E'match_identity text,\n    date_quality_warning text)'
  );
  v_summary := replace(
    v_summary,
    'v_service_date date := coalesce(p_service_date, current_date);',
    E'v_service_date date := coalesce(p_service_date, current_date);\n  v_caller_organization_id uuid;'
  );
  v_summary := replace(
    v_summary,
    E'if auth.uid() is null then\n    raise exception ''Authentication is required.'';\n  end if;',
    E'if auth.uid() is null then\n    raise exception ''Authentication is required.'';\n  end if;\n\n  select u.organization_id into v_caller_organization_id\n  from public.users u\n  where u.id = auth.uid() and u.is_active = true;\n\n  if v_caller_organization_id is null then\n    raise exception ''Active organization membership is required.'' using errcode = ''42501'';\n  end if;'
  );
  v_summary := replace(v_summary, 'c.claim_number,', E'c.claim_number,\n      o.name as facility_display_name,');
  v_summary := replace(
    v_summary,
    'coalesce(m.dispensary_date, c.service_date_from, c.created_at::date) as dispensed_date,',
    E'public.nhis_medicine_dispensing_date(m.dispensary_date, m.served_at, c.service_date_from) as dispensed_date,\n      public.nhis_medicine_date_quality_warning(m.dispensary_date, m.served_at, c.service_date_from) as date_quality_warning,'
  );
  v_summary := replace(
    v_summary,
    'join public.nhis_claim_medicines m on m.claim_id = c.id',
    E'join public.nhis_claim_medicines m on m.claim_id = c.id\n    join public.organizations o on o.id = c.organization_id'
  );
  v_summary := replace(
    v_summary,
    'coalesce(m.dispensary_date, c.service_date_from, c.created_at::date) <= v_service_date',
    E'(public.nhis_medicine_dispensing_date(m.dispensary_date, m.served_at, c.service_date_from) is null\n        or public.nhis_medicine_dispensing_date(m.dispensary_date, m.served_at, c.service_date_from) <= v_service_date)'
  );
  v_summary := replace(
    v_summary,
    'where (active_lines.dispensed_date + (active_lines.coverage_days - 1))::date >= v_service_date',
    E'where active_lines.dispensed_date is null\n       or (active_lines.dispensed_date + (active_lines.coverage_days - 1))::date >= v_service_date'
  );
  v_summary := replace(v_summary, 'p_current_organization_id is not null and visible_lines.organization_id = p_current_organization_id', 'visible_lines.organization_id = v_caller_organization_id');
  v_summary := replace(
    v_summary,
    E'then ''This HealthFlow facility''\n      else ''Another participating HealthFlow facility''',
    E'then ''This HealthFlow facility''\n      else visible_lines.facility_display_name'
  );
  v_summary := replace(
    v_summary,
    'end::text as match_identity',
    E'end::text as match_identity,\n    visible_lines.date_quality_warning::text as date_quality_warning'
  );

  if v_summary not like '%nhis_medicine_dispensing_date%'
     or v_summary not like '%v_caller_organization_id%'
     or v_summary not like '%date_quality_warning::text%' then
    raise exception 'Unexpected active-medication summary definition; safe date patch was not applied';
  end if;

  drop function public.get_nhis_patient_active_medications(text, text, date, uuid, uuid);
  execute v_summary;

end;
$$;

-- Keep the broad legacy sync core unchanged. This narrow adapter calls it first,
-- then replaces only the NHIS medicine rows with the complete offline clinical
-- metadata. Synchronization time is never substituted for served_at.
create or replace function public.branch_sync_upsert_nhis_claim_with_serving_metadata(
  p_sync_token text,
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
  v_response jsonb;
  v_organization_id uuid;
  v_item jsonb;
  v_served_qty numeric;
begin
  v_response := public.branch_sync_upsert_offline_record_core(
    p_sync_token,
    'nhis_claims',
    p_local_id,
    p_record
  );

  v_organization_id := nullif(v_response->>'organization_id', '')::uuid;
  if v_organization_id is null then
    raise exception 'Branch sync did not return an organization.';
  end if;

  update public.nhis_claims
  set
    service_date_from = nullif(p_record->>'service_date_from', '')::date,
    service_date_to = nullif(p_record->>'service_date_to', '')::date
  where id = p_local_id
    and organization_id = v_organization_id;

  if not found then
    raise exception 'Synchronized NHIS claim was not found in the branch organization.';
  end if;

  delete from public.nhis_claim_medicines m
  using public.nhis_claims c
  where m.claim_id = c.id
    and c.id = p_local_id
    and c.organization_id = v_organization_id;

  for v_item in
    select value
    from jsonb_array_elements(coalesce(p_record->'nhis_claim_medicines', '[]'::jsonb))
  loop
    v_served_qty := coalesce(
      nullif(v_item->>'served_qty', '')::numeric,
      nullif(v_item->>'dispensed_qty', '')::numeric,
      0
    );

    insert into public.nhis_claim_medicines (
      id, claim_id, nhis_drug_id, drug_code, description, unit, unit_price,
      dispensed_qty, dispensary_date, dose, frequency, duration, total_amount,
      medicine_access_level, required_pharmacy_level,
      prescribed_qty, served_qty, serving_status, reason_if_not_fully_served,
      entered_by_claims_officer, served_by_mca, entered_at, served_at
    )
    values (
      coalesce(nullif(v_item->>'id', '')::uuid, uuid_generate_v4()),
      p_local_id,
      nullif(v_item->>'nhis_drug_id', '')::uuid,
      nullif(v_item->>'drug_code', ''),
      nullif(v_item->>'description', ''),
      coalesce(nullif(v_item->>'unit', ''), 'unit'),
      coalesce(nullif(v_item->>'unit_price', '')::numeric, 0),
      coalesce(nullif(v_item->>'dispensed_qty', '')::numeric, 1),
      nullif(v_item->>'dispensary_date', '')::date,
      nullif(v_item->>'dose', ''),
      nullif(v_item->>'frequency', ''),
      nullif(v_item->>'duration', ''),
      coalesce(nullif(v_item->>'total_amount', '')::numeric, 0),
      nullif(v_item->>'medicine_access_level', ''),
      nullif(v_item->>'required_pharmacy_level', ''),
      coalesce(
        nullif(v_item->>'prescribed_qty', '')::numeric,
        nullif(v_item->>'dispensed_qty', '')::numeric,
        0
      ),
      v_served_qty,
      coalesce(
        nullif(v_item->>'serving_status', ''),
        case when v_served_qty > 0 then 'fully_served' else 'pending' end
      ),
      nullif(v_item->>'reason_if_not_fully_served', ''),
      nullif(v_item->>'entered_by_claims_officer', '')::uuid,
      nullif(v_item->>'served_by_mca', '')::uuid,
      nullif(v_item->>'entered_at', '')::timestamptz,
      nullif(v_item->>'served_at', '')::timestamptz
    );
  end loop;

  return v_response;
end;
$$;

revoke all on function public.branch_sync_upsert_nhis_claim_with_serving_metadata(text, uuid, jsonb)
  from public, anon, authenticated;

-- Preserve the deployed NHIS-drug router, adding only a narrow route for NHIS
-- claims that need the complete medicine serving metadata adapter above.
create or replace function public.branch_sync_upsert_offline_record(
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
  if p_entity_type = 'nhis_claims' then
    return public.branch_sync_upsert_nhis_claim_with_serving_metadata(
      p_sync_token,
      p_local_id,
      p_record
    );
  end if;

  if p_entity_type <> 'nhis_drugs' then
    return public.branch_sync_upsert_offline_record_core(
      p_sync_token,
      p_entity_type,
      p_local_id,
      p_record
    );
  end if;

  if p_local_id is null then
    raise exception 'Local record ID is required.';
  end if;

  if p_record is null or jsonb_typeof(p_record) <> 'object' then
    raise exception 'Invalid offline record payload.';
  end if;

  v_client := public.get_branch_sync_client(p_sync_token);

  insert into public.nhis_drugs (
    id, organization_id, code, description, generic_name, strength,
    dosage_form, category, unit, unit_price, is_active,
    medicine_access_level, required_pharmacy_level, created_at, updated_at
  )
  values (
    p_local_id,
    v_client.organization_id,
    nullif(upper(btrim(p_record->>'code')), ''),
    nullif(btrim(p_record->>'description'), ''),
    nullif(btrim(p_record->>'generic_name'), ''),
    nullif(btrim(p_record->>'strength'), ''),
    nullif(btrim(p_record->>'dosage_form'), ''),
    nullif(btrim(p_record->>'category'), ''),
    coalesce(nullif(btrim(p_record->>'unit'), ''), 'unit'),
    coalesce(nullif(p_record->>'unit_price', '')::numeric, 0),
    coalesce(nullif(p_record->>'is_active', '')::boolean, true),
    nullif(btrim(p_record->>'medicine_access_level'), ''),
    nullif(btrim(p_record->>'required_pharmacy_level'), ''),
    coalesce(nullif(p_record->>'created_at', '')::timestamptz, now()),
    coalesce(nullif(p_record->>'updated_at', '')::timestamptz, now())
  )
  on conflict (organization_id, code) do update set
    description = excluded.description,
    generic_name = excluded.generic_name,
    strength = excluded.strength,
    dosage_form = excluded.dosage_form,
    category = excluded.category,
    unit = excluded.unit,
    unit_price = excluded.unit_price,
    is_active = excluded.is_active,
    medicine_access_level = excluded.medicine_access_level,
    required_pharmacy_level = excluded.required_pharmacy_level,
    updated_at = excluded.updated_at
  returning id into v_remote_id;

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
    'record.upsert.nhis_drugs',
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

revoke all on function public.branch_sync_upsert_offline_record(text, text, uuid, jsonb)
  from public;
grant execute on function public.branch_sync_upsert_offline_record(text, text, uuid, jsonb)
  to anon, authenticated;

revoke all on function public.check_nhis_active_medication_overlap(
  text, text, text, date, uuid, uuid, text, text, text, numeric, text, text, text
) from public, anon;
grant execute on function public.check_nhis_active_medication_overlap(
  text, text, text, date, uuid, uuid, text, text, text, numeric, text, text, text
) to authenticated;

revoke all on function public.check_nhis_active_medication_overlap_batch(jsonb) from public, anon;
grant execute on function public.check_nhis_active_medication_overlap_batch(jsonb) to authenticated;

revoke all on function public.get_nhis_patient_active_medications(text, text, date, uuid, uuid) from public, anon;
grant execute on function public.get_nhis_patient_active_medications(text, text, date, uuid, uuid) to authenticated;

comment on function public.nhis_medicine_dispensing_date(date, timestamptz, date) is
  'Returns the authoritative NHIS medicine treatment calendar day without using record or synchronization timestamps.';

-- Read-only historical audit. This does not update or backfill any row.
create or replace view public.nhis_medicine_dispensing_date_audit
with (security_invoker = true)
as
select
  m.id as medicine_id,
  m.claim_id,
  c.organization_id,
  m.dispensary_date,
  (m.served_at at time zone 'Africa/Accra')::date as served_calendar_date,
  c.service_date_from,
  m.served_at,
  m.served_qty,
  m.dispensed_qty,
  m.serving_status,
  public.nhis_medicine_dispensing_date(m.dispensary_date, m.served_at, c.service_date_from) as effective_dispensing_date,
  public.nhis_medicine_date_quality_warning(m.dispensary_date, m.served_at, c.service_date_from) as date_quality_warning,
  case
    when m.dispensary_date is null and m.served_at is null and c.service_date_from is not null
      then true
    else false
  end as uses_service_date_fallback,
  case
    when m.served_at is null
      or m.serving_status is null
      or (coalesce(m.served_qty, m.dispensed_qty, 0) > 0 and m.served_qty is null)
      then true
    else false
  end as serving_metadata_incomplete
from public.nhis_claim_medicines m
join public.nhis_claims c on c.id = m.claim_id
where c.organization_id = public.user_organization_id()
  and (
    public.nhis_medicine_date_quality_warning(m.dispensary_date, m.served_at, c.service_date_from) is not null
    or m.dispensary_date is null
    or m.served_at is null
    or (m.dispensary_date is null and m.served_at is null and c.service_date_from is not null)
    or m.serving_status is null
    or (coalesce(m.served_qty, m.dispensed_qty, 0) > 0 and m.served_qty is null)
  );

revoke all on public.nhis_medicine_dispensing_date_audit from public, anon;
grant select on public.nhis_medicine_dispensing_date_audit to authenticated;

notify pgrst, 'reload schema';
