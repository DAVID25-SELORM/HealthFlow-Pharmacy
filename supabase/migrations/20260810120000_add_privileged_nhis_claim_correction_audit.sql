create table if not exists public.nhis_claim_corrections (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_role text not null,
  field_name text not null,
  previous_value jsonb,
  new_value jsonb,
  reason text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_nhis_claim_corrections_claim_created
  on public.nhis_claim_corrections (claim_id, created_at desc);
create index if not exists idx_nhis_claim_corrections_org_created
  on public.nhis_claim_corrections (organization_id, created_at desc);

alter table public.nhis_claim_corrections enable row level security;

revoke all on public.nhis_claim_corrections from anon, authenticated;
grant select on public.nhis_claim_corrections to authenticated;

drop policy if exists nhis_claim_corrections_select_privileged_same_org on public.nhis_claim_corrections;
create policy nhis_claim_corrections_select_privileged_same_org
  on public.nhis_claim_corrections for select to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users viewer
      where viewer.id = auth.uid()
        and viewer.is_active = true
        and (
          viewer.role in ('admin', 'claims_officer')
          or viewer.assigned_roles && array['admin', 'claims_officer']::text[]
        )
    )
  );

create or replace function public.record_nhis_claim_correction(
  p_claim_id uuid,
  p_reason text,
  p_changes jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_role text;
  v_change jsonb;
  v_count integer := 0;
begin
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Reason for correction is required.';
  end if;

  select c.organization_id into v_org_id
  from public.nhis_claims c
  where c.id = p_claim_id;

  if v_org_id is null or v_org_id <> public.user_organization_id() then
    raise exception 'Claim not found or access denied.';
  end if;

  select case
    when u.role in ('admin', 'claims_officer') then u.role
    when 'admin' = any(u.assigned_roles) then 'admin'
    when 'claims_officer' = any(u.assigned_roles) then 'claims_officer'
    else null
  end into v_role
  from public.users u
  where u.id = auth.uid() and u.is_active = true and u.organization_id = v_org_id;

  if v_role is null then
    raise exception 'Only an Admin or Claims Officer can record a privileged claim correction.';
  end if;

  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    return 0;
  end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    if nullif(btrim(v_change->>'field'), '') is not null
       and (v_change->'previous_value') is distinct from (v_change->'new_value') then
      insert into public.nhis_claim_corrections (
        claim_id, organization_id, actor_user_id, actor_role, field_name,
        previous_value, new_value, reason
      ) values (
        p_claim_id, v_org_id, auth.uid(), v_role, v_change->>'field',
        v_change->'previous_value', v_change->'new_value', btrim(p_reason)
      );
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.record_nhis_claim_correction(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.correct_nhis_claim_privileged(
  p_claim_id uuid,
  p_claim_patch jsonb,
  p_medicines jsonb,
  p_services jsonb,
  p_reason text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_claim public.nhis_claims%rowtype;
  v_new public.nhis_claims%rowtype;
  v_patch jsonb;
  v_old_json jsonb;
  v_new_json jsonb;
  v_old_medicines jsonb;
  v_new_medicines jsonb;
  v_old_services jsonb;
  v_new_services jsonb;
  v_field text;
  v_medicine jsonb;
  v_service jsonb;
  v_audit_rows jsonb;
  v_has_scalar_changes boolean;
  v_allowed_fields constant text[] := array[
    'patient_id', 'branch_id', 'member_no', 'card_type', 'hin', 'surname', 'other_names',
    'folder_no', 'gender', 'date_of_birth', 'patient_address', 'child_weight_kg', 'ccc_no',
    'nhia_transaction_id', 'nhia_eligibility_start_date', 'nhia_eligibility_end_date',
    'nhia_attendance_date', 'nhia_auth_id', 'nhia_auth_type', 'nhia_new_ccc_status', 'nhia_otac',
    'nhia_attendance_verification_status', 'nhia_attendance_verification_source',
    'nhia_member_status', 'nhia_member_lookup_payload', 'diagnosis', 'diagnosis_details',
    'service_date_from', 'service_date_to', 'referring_facility', 'referral_code',
    'physician_name', 'pre_auth_codes', 'prescriber_id', 'prescribing_facility_id',
    'prescription_date', 'prescription_reference', 'prescriber_name_snapshot',
    'prescriber_license_snapshot', 'prescribing_facility_name_snapshot',
    'prescribing_facility_code_snapshot', 'prescription_entered_by', 'prescription_entered_at',
    'prescription_updated_by', 'prescription_updated_at', 'prescription_entry_user_name',
    'prescription_update_user_name', 'prescription_file_url', 'prescription_file_path',
    'prescription_file_name', 'prescription_file_type', 'prescription_file_size',
    'prescription_document_type', 'prescription_verified', 'prescription_verified_by',
    'prescription_verified_at', 'claimit_attachment_file_name', 'claimit_attachment_file_type',
    'claimit_attachment_mime_type', 'claimit_attachment_base64', 'total_amount', 'status',
    'serving_status', 'serving_reviewed_by', 'serving_reviewed_at', 'notes',
    'unserved_medicines_note', 'encounter_outcome', 'no_medicine_reason', 'no_lab_reason',
    'no_procedure_reason', 'external_prescription_status'
  ];
begin
  if v_actor_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Reason for correction is required.' using errcode = '22023';
  end if;
  if p_expected_updated_at is null then
    raise exception 'Expected updated_at is required.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_claim_patch, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_medicines, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_services, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid correction payload.' using errcode = '22023';
  end if;

  select case
    when u.role = 'admin' or 'admin' = any(u.assigned_roles) then 'admin'
    when u.role = 'claims_officer' or 'claims_officer' = any(u.assigned_roles) then 'claims_officer'
    else null
  end
  into v_actor_role
  from public.users u
  where u.id = v_actor_id and u.is_active = true;

  if v_actor_role is null then
    raise exception 'Only an Admin or Claims Officer can correct this claim.' using errcode = '42501';
  end if;

  select * into v_claim
  from public.nhis_claims c
  where c.id = p_claim_id
    and c.organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users u
      where u.id = v_actor_id and u.is_active = true
        and u.organization_id = c.organization_id
    )
  for update;

  if not found then
    raise exception 'NHIS claim not found or access denied.' using errcode = '42501';
  end if;
  if v_claim.updated_at is distinct from p_expected_updated_at then
    raise exception 'This claim was modified by another user. Reload the latest version before saving.'
      using errcode = '40001';
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  into v_patch
  from jsonb_each(coalesce(p_claim_patch, '{}'::jsonb))
  where key = any(v_allowed_fields);

  v_new := jsonb_populate_record(v_claim, v_patch);
  v_new.id := v_claim.id;
  v_new.organization_id := v_claim.organization_id;
  v_new.claim_number := v_claim.claim_number;
  v_new.created_by := v_claim.created_by;
  v_new.created_at := v_claim.created_at;
  v_new.updated_at := clock_timestamp();

  select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(m) - array['id','claim_id','created_at']) order by m.created_at, m.id), '[]'::jsonb)
    into v_old_medicines from public.nhis_claim_medicines m where m.claim_id = p_claim_id;
  select coalesce(jsonb_agg(jsonb_strip_nulls(value - array['id','claim_id','created_at'])), '[]'::jsonb)
    into v_new_medicines from jsonb_array_elements(p_medicines);
  select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(s) - array['id','claim_id','created_at']) order by s.created_at, s.id), '[]'::jsonb)
    into v_old_services from public.nhis_claim_services s where s.claim_id = p_claim_id;
  select coalesce(jsonb_agg(jsonb_strip_nulls(value - array['id','claim_id','created_at'])), '[]'::jsonb)
    into v_new_services from jsonb_array_elements(p_services);

  v_old_json := to_jsonb(v_claim);
  v_new_json := to_jsonb(v_new);
  select exists (
    select 1 from unnest(v_allowed_fields) as allowed(field_name)
    where (v_old_json -> allowed.field_name) is distinct from (v_new_json -> allowed.field_name)
  ) into v_has_scalar_changes;

  if not v_has_scalar_changes
     and v_old_medicines is not distinct from v_new_medicines
     and v_old_services is not distinct from v_new_services then
    return jsonb_build_object(
      'claim', to_jsonb(v_claim),
      'medicines', v_old_medicines,
      'services', v_old_services,
      'audit', '[]'::jsonb
    );
  end if;

  update public.nhis_claims set
    branch_id=v_new.branch_id, patient_id=v_new.patient_id, member_no=v_new.member_no,
    card_type=v_new.card_type, hin=v_new.hin, surname=v_new.surname, other_names=v_new.other_names,
    folder_no=v_new.folder_no, gender=v_new.gender, date_of_birth=v_new.date_of_birth,
    patient_address=v_new.patient_address, child_weight_kg=v_new.child_weight_kg, ccc_no=v_new.ccc_no,
    nhia_transaction_id=v_new.nhia_transaction_id, nhia_eligibility_start_date=v_new.nhia_eligibility_start_date,
    nhia_eligibility_end_date=v_new.nhia_eligibility_end_date, nhia_attendance_date=v_new.nhia_attendance_date,
    nhia_auth_id=v_new.nhia_auth_id, nhia_auth_type=v_new.nhia_auth_type,
    nhia_new_ccc_status=v_new.nhia_new_ccc_status, nhia_otac=v_new.nhia_otac,
    nhia_attendance_verification_status=v_new.nhia_attendance_verification_status,
    nhia_attendance_verification_source=v_new.nhia_attendance_verification_source,
    nhia_member_status=v_new.nhia_member_status, nhia_member_lookup_payload=v_new.nhia_member_lookup_payload,
    diagnosis=v_new.diagnosis, diagnosis_details=v_new.diagnosis_details,
    service_date_from=v_new.service_date_from, service_date_to=v_new.service_date_to,
    referring_facility=v_new.referring_facility, referral_code=v_new.referral_code,
    physician_name=v_new.physician_name, pre_auth_codes=v_new.pre_auth_codes,
    prescriber_id=v_new.prescriber_id, prescribing_facility_id=v_new.prescribing_facility_id,
    prescription_date=v_new.prescription_date, prescription_reference=v_new.prescription_reference,
    prescriber_name_snapshot=v_new.prescriber_name_snapshot, prescriber_license_snapshot=v_new.prescriber_license_snapshot,
    prescribing_facility_name_snapshot=v_new.prescribing_facility_name_snapshot,
    prescribing_facility_code_snapshot=v_new.prescribing_facility_code_snapshot,
    prescription_entered_by=v_new.prescription_entered_by, prescription_entered_at=v_new.prescription_entered_at,
    prescription_updated_by=v_new.prescription_updated_by, prescription_updated_at=v_new.prescription_updated_at,
    prescription_entry_user_name=v_new.prescription_entry_user_name,
    prescription_update_user_name=v_new.prescription_update_user_name,
    prescription_file_url=v_new.prescription_file_url, prescription_file_path=v_new.prescription_file_path,
    prescription_file_name=v_new.prescription_file_name, prescription_file_type=v_new.prescription_file_type,
    prescription_file_size=v_new.prescription_file_size, prescription_document_type=v_new.prescription_document_type,
    prescription_verified=v_new.prescription_verified, prescription_verified_by=v_new.prescription_verified_by,
    prescription_verified_at=v_new.prescription_verified_at,
    claimit_attachment_file_name=v_new.claimit_attachment_file_name,
    claimit_attachment_file_type=v_new.claimit_attachment_file_type,
    claimit_attachment_mime_type=v_new.claimit_attachment_mime_type,
    claimit_attachment_base64=v_new.claimit_attachment_base64, total_amount=v_new.total_amount,
    status=v_new.status, serving_status=v_new.serving_status, serving_reviewed_by=v_new.serving_reviewed_by,
    serving_reviewed_at=v_new.serving_reviewed_at, notes=v_new.notes,
    unserved_medicines_note=v_new.unserved_medicines_note, encounter_outcome=v_new.encounter_outcome,
    no_medicine_reason=v_new.no_medicine_reason, no_lab_reason=v_new.no_lab_reason,
    no_procedure_reason=v_new.no_procedure_reason, external_prescription_status=v_new.external_prescription_status,
    updated_at=v_new.updated_at
  where id = p_claim_id;

  delete from public.nhis_claim_medicines where claim_id = p_claim_id;
  for v_medicine in select value from jsonb_array_elements(p_medicines) loop
    insert into public.nhis_claim_medicines (
      claim_id, nhis_drug_id, drug_code, description, unit, unit_price, dispensed_qty,
      dispensary_date, dose, frequency, duration, total_amount, medicine_access_level,
      required_pharmacy_level, prescribed_qty, served_qty, serving_status,
      reason_if_not_fully_served, entered_by_claims_officer, served_by_mca, entered_at, served_at
    ) values (
      p_claim_id, nullif(v_medicine->>'nhis_drug_id','')::uuid, v_medicine->>'drug_code',
      v_medicine->>'description', coalesce(v_medicine->>'unit','unit'),
      coalesce((v_medicine->>'unit_price')::numeric,0), coalesce((v_medicine->>'dispensed_qty')::numeric,0),
      nullif(v_medicine->>'dispensary_date','')::date, v_medicine->>'dose', v_medicine->>'frequency',
      v_medicine->>'duration', coalesce((v_medicine->>'total_amount')::numeric,0),
      v_medicine->>'medicine_access_level', v_medicine->>'required_pharmacy_level',
      coalesce((v_medicine->>'prescribed_qty')::numeric,0), coalesce((v_medicine->>'served_qty')::numeric,0),
      coalesce(v_medicine->>'serving_status','pending'), v_medicine->>'reason_if_not_fully_served',
      nullif(v_medicine->>'entered_by_claims_officer','')::uuid, nullif(v_medicine->>'served_by_mca','')::uuid,
      nullif(v_medicine->>'entered_at','')::timestamptz, nullif(v_medicine->>'served_at','')::timestamptz
    );
  end loop;

  delete from public.nhis_claim_services where claim_id = p_claim_id;
  for v_service in select value from jsonb_array_elements(p_services) loop
    insert into public.nhis_claim_services (
      claim_id, nhia_tariff_item_id, tariff_version, facility_group, catering_option, mdc,
      gdrg_code, description, age_band, unit_price, quantity, service_date, total_amount, source_file, source_page
    ) values (
      p_claim_id, nullif(v_service->>'nhia_tariff_item_id','')::uuid,
      coalesce(v_service->>'tariff_version','FEB 2023'), v_service->>'facility_group',
      v_service->>'catering_option', v_service->>'mdc', v_service->>'gdrg_code',
      v_service->>'description', v_service->>'age_band', coalesce((v_service->>'unit_price')::numeric,0),
      coalesce((v_service->>'quantity')::numeric,1), nullif(v_service->>'service_date','')::date,
      coalesce((v_service->>'total_amount')::numeric,0), v_service->>'source_file',
      nullif(v_service->>'source_page','')::integer
    );
  end loop;

  foreach v_field in array v_allowed_fields loop
    if v_old_json->v_field is distinct from v_new_json->v_field then
      insert into public.nhis_claim_corrections (
        claim_id, organization_id, actor_user_id, actor_role, field_name, previous_value, new_value, reason
      ) values (
        p_claim_id, v_claim.organization_id, v_actor_id, v_actor_role, v_field,
        v_old_json->v_field, v_new_json->v_field, btrim(p_reason)
      );
    end if;
  end loop;
  if v_old_medicines is distinct from v_new_medicines then
    insert into public.nhis_claim_corrections
      (claim_id, organization_id, actor_user_id, actor_role, field_name, previous_value, new_value, reason)
    values (p_claim_id, v_claim.organization_id, v_actor_id, v_actor_role, 'medicines', v_old_medicines, v_new_medicines, btrim(p_reason));
  end if;
  if v_old_services is distinct from v_new_services then
    insert into public.nhis_claim_corrections
      (claim_id, organization_id, actor_user_id, actor_role, field_name, previous_value, new_value, reason)
    values (p_claim_id, v_claim.organization_id, v_actor_id, v_actor_role, 'services_tariffs', v_old_services, v_new_services, btrim(p_reason));
  end if;

  if v_new.patient_id is not null and (v_new.member_no is not null or v_new.hin is not null) then
    update public.patients
    set nhis_member_no = v_new.member_no,
        nhis_hin = v_new.hin,
        insurance_provider = 'NHIS',
        insurance_id = coalesce(v_new.member_no, v_new.hin)
    where id = v_new.patient_id
      and organization_id = v_claim.organization_id;
  end if;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at, a.id), '[]'::jsonb)
  into v_audit_rows
  from public.nhis_claim_corrections a
  where a.claim_id = p_claim_id and a.actor_user_id = v_actor_id and a.created_at >= v_new.updated_at;

  return jsonb_build_object(
    'claim', to_jsonb(v_new),
    'medicines', v_new_medicines,
    'services', v_new_services,
    'audit', v_audit_rows
  );
end;
$$;

revoke all on function public.correct_nhis_claim_privileged(uuid, jsonb, jsonb, jsonb, text, timestamptz) from public, anon;
grant execute on function public.correct_nhis_claim_privileged(uuid, jsonb, jsonb, jsonb, text, timestamptz) to authenticated;

comment on table public.nhis_claim_corrections is
  'Immutable field-level history for Admin and Claims Officer corrections to saved NHIS claims.';
