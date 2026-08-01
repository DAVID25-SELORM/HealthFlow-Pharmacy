-- Fix active-medication coverage math for hourly frequencies, daily partial fills,
-- and future-dated comparison windows.
--
-- This changes only the advisory/scrub calculation. It does not alter NHIS export,
-- Ghana Card/HIN mapping, CCC generation, pricing, tariffs, claim totals, or CXF generation.

drop function if exists public.check_nhis_active_medication_overlap_batch(jsonb);
drop function if exists public.check_nhis_active_medication_overlap(
  text, text, text, date, uuid, uuid, text, text, text, numeric, text, text, text
);

create or replace function public.check_nhis_active_medication_overlap(
  p_member_no text default null,
  p_hin text default null,
  p_medicine_code text default null,
  p_service_date date default current_date,
  p_current_claim_id uuid default null,
  p_current_organization_id uuid default null,
  p_generic_name text default null,
  p_strength text default null,
  p_dosage_form text default null,
  p_requested_quantity numeric default null,
  p_dose text default null,
  p_frequency text default null,
  p_duration text default null
)
returns table (
  severity text,
  match_type text,
  medicine_code text,
  medicine_description text,
  previous_dispensed_date date,
  coverage_end_date date,
  remaining_days integer,
  source_label text,
  previous_claim_reference text,
  risk_score integer,
  risk_reasons text[],
  recommended_action text,
  previous_quantity_supplied numeric,
  previous_dose text,
  previous_frequency text,
  calculated_administrations_per_day numeric,
  calculated_treatment_days numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_no text := upper(regexp_replace(coalesce(p_member_no, ''), '[^A-Za-z0-9]', '', 'g'));
  v_hin text := upper(regexp_replace(coalesce(p_hin, ''), '[^A-Za-z0-9]', '', 'g'));
  v_medicine_code text := upper(trim(coalesce(p_medicine_code, '')));
  v_generic_name text := lower(regexp_replace(coalesce(p_generic_name, ''), '\s+', ' ', 'g'));
  v_strength text := lower(regexp_replace(coalesce(p_strength, ''), '\s+', ' ', 'g'));
  v_dosage_form text := lower(regexp_replace(coalesce(p_dosage_form, ''), '\s+', ' ', 'g'));
  v_service_date date := coalesce(p_service_date, current_date);
  v_requested_quantity numeric := nullif(p_requested_quantity, 0);
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if (v_medicine_code = '' and v_generic_name = '') or (v_member_no = '' and v_hin = '') then
    return;
  end if;

  return query
  with candidate_raw as (
    select
      c.id as claim_id,
      c.organization_id,
      c.claim_number,
      upper(regexp_replace(coalesce(c.member_no, ''), '[^A-Za-z0-9]', '', 'g')) as member_no_key,
      upper(regexp_replace(coalesce(c.hin, ''), '[^A-Za-z0-9]', '', 'g')) as hin_key,
      upper(trim(coalesce(m.drug_code, ''))) as drug_code_key,
      lower(regexp_replace(coalesce(d.generic_name, ''), '\s+', ' ', 'g')) as generic_key,
      lower(regexp_replace(coalesce(d.strength, ''), '\s+', ' ', 'g')) as strength_key,
      lower(regexp_replace(coalesce(d.dosage_form, ''), '\s+', ' ', 'g')) as dosage_form_key,
      coalesce(nullif(trim(m.description), ''), nullif(trim(d.description), ''), trim(m.drug_code), 'Medicine') as description,
      coalesce(m.dispensary_date, c.service_date_from, c.created_at::date) as dispensed_date,
      coalesce(nullif(m.prescribed_qty, 0), nullif(m.dispensed_qty, 0), nullif(m.served_qty, 0), 0)::numeric as prescribed_quantity,
      coalesce(nullif(m.served_qty, 0), nullif(m.dispensed_qty, 0), 0)::numeric as served_quantity,
      lower(regexp_replace(coalesce(m.duration, ''), '\s+', ' ', 'g')) as duration_text,
      lower(regexp_replace(coalesce(m.frequency, ''), '\s+', ' ', 'g')) as frequency_text,
      lower(regexp_replace(coalesce(m.dose, ''), '\s+', ' ', 'g')) as dose_text
    from public.nhis_claims c
    join public.nhis_claim_medicines m on m.claim_id = c.id
    left join public.nhis_drugs d
      on d.organization_id = c.organization_id
      and (
        d.id = m.nhis_drug_id
        or upper(trim(coalesce(d.code, ''))) = upper(trim(coalesce(m.drug_code, '')))
      )
    where (p_current_claim_id is null or c.id <> p_current_claim_id)
      and coalesce(m.served_qty, m.dispensed_qty, 0) > 0
      and coalesce(m.dispensary_date, c.service_date_from, c.created_at::date) <= v_service_date
      and lower(coalesce(m.serving_status, 'fully_served')) not in ('pending', 'not_available', 'not_served')
      and lower(coalesce(c.status, '')) not in ('draft', 'pending_serving', 'serving_in_progress', 'rejected', 'cancelled', 'deleted')
      and (
        (v_member_no <> '' and upper(regexp_replace(coalesce(c.member_no, ''), '[^A-Za-z0-9]', '', 'g')) = v_member_no)
        or
        (v_hin <> '' and upper(regexp_replace(coalesce(c.hin, ''), '[^A-Za-z0-9]', '', 'g')) = v_hin)
      )
  ),
  candidate_lines as (
    select
      candidate_raw.*,
      case
        when candidate_raw.frequency_text ~ '\mq\s*4\s*h\M' or candidate_raw.frequency_text ~ '\m4[-\s]*(hourly|hour|hours|hr|hrs|hrly|h)\M' then 6::numeric
        when candidate_raw.frequency_text ~ '\mq\s*6\s*h\M' or candidate_raw.frequency_text ~ '\m6[-\s]*(hourly|hour|hours|hr|hrs|hrly|h)\M' then 4::numeric
        when candidate_raw.frequency_text ~ '\mq\s*8\s*h\M' or candidate_raw.frequency_text ~ '\m8[-\s]*(hourly|hour|hours|hr|hrs|hrly|h)\M' then 3::numeric
        when candidate_raw.frequency_text ~ '\mq\s*12\s*h\M' or candidate_raw.frequency_text ~ '\m12[-\s]*(hourly|hour|hours|hr|hrs|hrly|h)\M' then 2::numeric
        when candidate_raw.frequency_text ~ '\mq\s*24\s*h\M' or candidate_raw.frequency_text ~ '\m24[-\s]*(hourly|hour|hours|hr|hrs|hrly|h)\M' then 1::numeric
        when candidate_raw.frequency_text ~ '\m(qid|qds)\M' or candidate_raw.frequency_text like '%four times%' then 4::numeric
        when candidate_raw.frequency_text ~ '\m(tds|tid)\M' or candidate_raw.frequency_text like '%three times%' then 3::numeric
        when candidate_raw.frequency_text ~ '\m(bd|bid)\M' or candidate_raw.frequency_text like '%twice%' or candidate_raw.frequency_text like '%two times%' then 2::numeric
        when candidate_raw.frequency_text ~ '\m(od)\M' or candidate_raw.frequency_text like '%daily%' or candidate_raw.frequency_text like '%once%' or candidate_raw.frequency_text like '%nocte%' then 1::numeric
        when substring(candidate_raw.frequency_text from '(\d+)\s*(?:x|times)') is not null
          then nullif(substring(candidate_raw.frequency_text from '(\d+)\s*(?:x|times)'), '')::numeric
        else null
      end as frequency_per_day,
      coalesce(nullif(substring(candidate_raw.dose_text from '(\d+(?:\.\d+)?)'), '')::numeric, 1)::numeric as dose_units,
      nullif(substring(candidate_raw.duration_text from '(\d+(?:\.\d+)?)'), '')::numeric as duration_number
    from candidate_raw
  ),
  measured_lines as (
    select
      candidate_lines.*,
      case
        when candidate_lines.served_quantity > 0
          and candidate_lines.frequency_per_day > 0
          and candidate_lines.dose_units > 0
          then candidate_lines.served_quantity / (candidate_lines.frequency_per_day * candidate_lines.dose_units)
        else null
      end as treatment_days_supplied,
      case
        when candidate_lines.duration_number is not null and candidate_lines.duration_text like '%month%'
          then round(candidate_lines.duration_number * 30)::integer
        when candidate_lines.duration_number is not null and candidate_lines.duration_text like '%week%'
          then round(candidate_lines.duration_number * 7)::integer
        when candidate_lines.duration_number is not null
          then round(candidate_lines.duration_number)::integer
        else null
      end as duration_days_from_text
    from candidate_lines
  ),
  coverage_lines as (
    select
      measured_lines.*,
      least(
        greatest(
          coalesce(
            ceil(measured_lines.treatment_days_supplied)::integer,
            measured_lines.duration_days_from_text,
            1
          ),
          1
        ),
        90
      ) as coverage_days,
      greatest(measured_lines.prescribed_quantity - measured_lines.served_quantity, 0)::numeric as previous_unserved_quantity
    from measured_lines
  ),
  matched_lines as (
    select
      coverage_lines.*,
      case
        when v_medicine_code <> '' and coverage_lines.drug_code_key = v_medicine_code
          then 'exact_code'
        when v_generic_name <> ''
          and coverage_lines.generic_key = v_generic_name
          and (v_strength = '' or coverage_lines.strength_key = v_strength)
          and (v_dosage_form = '' or coverage_lines.dosage_form_key = v_dosage_form)
          then 'same_ingredient'
        else null
      end as overlap_match_type
    from coverage_lines
  ),
  active_matches as (
    select
      matched_lines.*,
      (matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date as computed_coverage_end_date,
      greatest(((matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date - v_service_date + 1), 0)::integer as computed_remaining_days,
      case
        when matched_lines.previous_unserved_quantity > 0
          and v_requested_quantity is not null
          and v_requested_quantity <= matched_lines.previous_unserved_quantity
          and v_service_date > matched_lines.dispensed_date
          then 'possible_completion_supply'
        when matched_lines.previous_unserved_quantity > 0
          then 'partial_previous_supply'
        when ((matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date - v_service_date + 1) >= 7
          then 'early_refill_review'
        else matched_lines.overlap_match_type
      end as advisory_type
    from matched_lines
    where matched_lines.overlap_match_type is not null
      and (matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date >= v_service_date
  ),
  scored_matches as (
    select
      active_matches.*,
      least(
        100,
        greatest(
          5,
          (case when active_matches.overlap_match_type = 'exact_code' then 45 else 25 end)
          + (case when active_matches.computed_remaining_days >= 7 then 20 when active_matches.computed_remaining_days > 0 then 10 else 0 end)
          + (case when p_current_organization_id is not null and active_matches.organization_id <> p_current_organization_id then 15 else 5 end)
          + (case when active_matches.advisory_type = 'possible_completion_supply' then -25 else 0 end)
          + (case when active_matches.advisory_type = 'partial_previous_supply' then -10 else 0 end)
          + (case when v_requested_quantity is not null and active_matches.previous_unserved_quantity > 0 and v_requested_quantity > active_matches.previous_unserved_quantity then 10 else 0 end)
        )
      )::integer as computed_risk_score
    from active_matches
  )
  select
    case
      when scored_matches.advisory_type = 'possible_completion_supply' then 'info'
      when scored_matches.overlap_match_type = 'exact_code' then 'strong_warning'
      else 'warning'
    end::text as severity,
    scored_matches.advisory_type::text as match_type,
    scored_matches.drug_code_key::text as medicine_code,
    scored_matches.description::text as medicine_description,
    scored_matches.dispensed_date::date as previous_dispensed_date,
    scored_matches.computed_coverage_end_date::date as coverage_end_date,
    scored_matches.computed_remaining_days::integer as remaining_days,
    case
      when p_current_organization_id is not null and scored_matches.organization_id = p_current_organization_id
        then 'This HealthFlow facility'
      else 'Another participating HealthFlow facility'
    end::text as source_label,
    case
      when p_current_organization_id is not null and scored_matches.organization_id = p_current_organization_id
        then coalesce(scored_matches.claim_number, scored_matches.claim_id::text)
      else null
    end::text as previous_claim_reference,
    scored_matches.computed_risk_score::integer as risk_score,
    array_remove(array[
      case when scored_matches.overlap_match_type = 'exact_code' then 'Same medicine was served recently.' else 'Similar active ingredient was served recently.' end,
      case when scored_matches.computed_remaining_days > 0 then scored_matches.computed_remaining_days::text || ' treatment day(s) may still remain.' else null end,
      case when scored_matches.advisory_type = 'possible_completion_supply' then 'Requested quantity may be completing a previous partial fill on a later dispensing day.' else null end,
      case when scored_matches.advisory_type = 'partial_previous_supply' then 'Previous claim was not fully supplied; confirm whether this is completion or replacement.' else null end,
      case when v_requested_quantity is not null and scored_matches.previous_unserved_quantity > 0 and v_requested_quantity > scored_matches.previous_unserved_quantity then 'Requested quantity is greater than the previous unserved balance.' else null end,
      case when p_current_organization_id is not null and scored_matches.organization_id <> p_current_organization_id then 'Previous supply was recorded by another participating facility.' else null end
    ], null)::text[] as risk_reasons,
    case
      when scored_matches.advisory_type = 'possible_completion_supply'
        then 'Confirm this is a completion supply for medicine previously not fully served.'
      when scored_matches.computed_risk_score >= 70
        then 'Review with the claims officer before dispensing; document the authorized reason if continued.'
      else 'Review before adding this medicine and record the authorized reason if continued.'
    end::text as recommended_action,
    scored_matches.served_quantity::numeric as previous_quantity_supplied,
    scored_matches.dose_text::text as previous_dose,
    scored_matches.frequency_text::text as previous_frequency,
    scored_matches.frequency_per_day::numeric as calculated_administrations_per_day,
    round(scored_matches.treatment_days_supplied, 2)::numeric as calculated_treatment_days
  from scored_matches
  order by
    case when scored_matches.overlap_match_type = 'exact_code' then 0 else 1 end,
    scored_matches.computed_risk_score desc,
    scored_matches.computed_coverage_end_date desc,
    scored_matches.dispensed_date desc
  limit 5;
end;
$$;

revoke all on function public.check_nhis_active_medication_overlap(text, text, text, date, uuid, uuid, text, text, text, numeric, text, text, text) from public;
grant execute on function public.check_nhis_active_medication_overlap(text, text, text, date, uuid, uuid, text, text, text, numeric, text, text, text) to authenticated;

create or replace function public.check_nhis_active_medication_overlap_batch(
  p_items jsonb default '[]'::jsonb
)
returns table (
  input_claim_id uuid,
  severity text,
  match_type text,
  medicine_code text,
  medicine_description text,
  previous_dispensed_date date,
  coverage_end_date date,
  remaining_days integer,
  source_label text,
  previous_claim_reference text,
  risk_score integer,
  risk_reasons text[],
  recommended_action text,
  previous_quantity_supplied numeric,
  previous_dose text,
  previous_frequency text,
  calculated_administrations_per_day numeric,
  calculated_treatment_days numeric
)
language sql
security definer
set search_path = public
as $$
  with input_items as (
    select *
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as item(
      claim_id uuid,
      member_no text,
      hin text,
      medicine_code text,
      service_date date,
      current_organization_id uuid,
      generic_name text,
      strength text,
      dosage_form text,
      requested_quantity numeric,
      dose text,
      frequency text,
      duration text
    )
  )
  select
    input_items.claim_id as input_claim_id,
    overlap.severity,
    overlap.match_type,
    overlap.medicine_code,
    overlap.medicine_description,
    overlap.previous_dispensed_date,
    overlap.coverage_end_date,
    overlap.remaining_days,
    overlap.source_label,
    overlap.previous_claim_reference,
    overlap.risk_score,
    overlap.risk_reasons,
    overlap.recommended_action,
    overlap.previous_quantity_supplied,
    overlap.previous_dose,
    overlap.previous_frequency,
    overlap.calculated_administrations_per_day,
    overlap.calculated_treatment_days
  from input_items
  cross join lateral public.check_nhis_active_medication_overlap(
    input_items.member_no,
    input_items.hin,
    input_items.medicine_code,
    input_items.service_date,
    input_items.claim_id,
    input_items.current_organization_id,
    input_items.generic_name,
    input_items.strength,
    input_items.dosage_form,
    input_items.requested_quantity,
    input_items.dose,
    input_items.frequency,
    input_items.duration
  ) as overlap;
$$;

revoke all on function public.check_nhis_active_medication_overlap_batch(jsonb) from public;
grant execute on function public.check_nhis_active_medication_overlap_batch(jsonb) to authenticated;
