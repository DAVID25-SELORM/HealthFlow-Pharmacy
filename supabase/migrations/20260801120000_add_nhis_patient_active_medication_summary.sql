-- Patient-level active-medication summary for real-time walk-in review.
-- This is read-only advisory visibility. It does not change CCC, export, pricing,
-- tariffs, claim totals, submission, duplicate detection, or existing blocker rules.

drop function if exists public.get_nhis_patient_active_medications(text, text, date, uuid, uuid);

create or replace function public.get_nhis_patient_active_medications(
  p_member_no text default null,
  p_hin text default null,
  p_service_date date default current_date,
  p_current_claim_id uuid default null,
  p_current_organization_id uuid default null
)
returns table (
  medicine_code text,
  medicine_description text,
  previous_dispensed_date date,
  coverage_end_date date,
  remaining_days integer,
  source_label text,
  previous_claim_reference text,
  previous_quantity_supplied numeric,
  previous_dose text,
  previous_frequency text,
  calculated_administrations_per_day numeric,
  calculated_treatment_days numeric,
  match_identity text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_no text := upper(regexp_replace(coalesce(p_member_no, ''), '[^A-Za-z0-9]', '', 'g'));
  v_hin text := upper(regexp_replace(coalesce(p_hin, ''), '[^A-Za-z0-9]', '', 'g'));
  v_service_date date := coalesce(p_service_date, current_date);
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if v_member_no = '' and v_hin = '' then
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
  active_lines as (
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
      ) as coverage_days
    from measured_lines
  ),
  visible_lines as (
    select
      active_lines.*,
      (active_lines.dispensed_date + (active_lines.coverage_days - 1))::date as computed_coverage_end_date,
      greatest(((active_lines.dispensed_date + (active_lines.coverage_days - 1))::date - v_service_date + 1), 0)::integer as computed_remaining_days
    from active_lines
    where (active_lines.dispensed_date + (active_lines.coverage_days - 1))::date >= v_service_date
  )
  select
    visible_lines.drug_code_key::text as medicine_code,
    visible_lines.description::text as medicine_description,
    visible_lines.dispensed_date::date as previous_dispensed_date,
    visible_lines.computed_coverage_end_date::date as coverage_end_date,
    visible_lines.computed_remaining_days::integer as remaining_days,
    case
      when p_current_organization_id is not null and visible_lines.organization_id = p_current_organization_id
        then 'This HealthFlow facility'
      else 'Another participating HealthFlow facility'
    end::text as source_label,
    case
      when p_current_organization_id is not null and visible_lines.organization_id = p_current_organization_id
        then coalesce(visible_lines.claim_number, visible_lines.claim_id::text)
      else null
    end::text as previous_claim_reference,
    visible_lines.served_quantity::numeric as previous_quantity_supplied,
    visible_lines.dose_text::text as previous_dose,
    visible_lines.frequency_text::text as previous_frequency,
    visible_lines.frequency_per_day::numeric as calculated_administrations_per_day,
    round(visible_lines.treatment_days_supplied, 2)::numeric as calculated_treatment_days,
    case
      when v_hin <> '' and visible_lines.hin_key = v_hin then 'hin'
      when v_member_no <> '' and visible_lines.member_no_key = v_member_no then 'member_no'
      else 'member'
    end::text as match_identity
  from visible_lines
  order by
    visible_lines.computed_remaining_days desc,
    visible_lines.computed_coverage_end_date desc,
    visible_lines.dispensed_date desc,
    visible_lines.description asc
  limit 20;
end;
$$;

revoke all on function public.get_nhis_patient_active_medications(text, text, date, uuid, uuid) from public;
grant execute on function public.get_nhis_patient_active_medications(text, text, date, uuid, uuid) to authenticated;
