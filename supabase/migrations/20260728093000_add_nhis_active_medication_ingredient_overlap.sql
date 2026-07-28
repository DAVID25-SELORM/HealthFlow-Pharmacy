-- Phase 2 active-medication coverage check: exact-code warning plus
-- generic/strength/form advisory. Read-only; no CCC, pricing, tariff,
-- duplicate-claim, export, submission, installer, branch-token, or sync changes.

drop function if exists public.check_nhis_active_medication_overlap(text, text, text, date, uuid, uuid);

create or replace function public.check_nhis_active_medication_overlap(
  p_member_no text default null,
  p_hin text default null,
  p_medicine_code text default null,
  p_service_date date default current_date,
  p_current_claim_id uuid default null,
  p_current_organization_id uuid default null,
  p_generic_name text default null,
  p_strength text default null,
  p_dosage_form text default null
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
  previous_claim_reference text
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
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if (v_medicine_code = '' and v_generic_name = '') or (v_member_no = '' and v_hin = '') then
    return;
  end if;

  return query
  with candidate_lines as (
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
      least(
        greatest(
          coalesce(nullif(substring(coalesce(m.duration, '') from '\d+'), '')::integer, 1),
          1
        ),
        90
      ) as coverage_days
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
      and lower(coalesce(m.serving_status, 'fully_served')) not in ('pending', 'not_available', 'not_served')
      and lower(coalesce(c.status, '')) not in ('draft', 'pending_serving', 'serving_in_progress', 'rejected', 'cancelled', 'deleted')
      and (
        (v_member_no <> '' and upper(regexp_replace(coalesce(c.member_no, ''), '[^A-Za-z0-9]', '', 'g')) = v_member_no)
        or
        (v_hin <> '' and upper(regexp_replace(coalesce(c.hin, ''), '[^A-Za-z0-9]', '', 'g')) = v_hin)
      )
  ),
  matched_lines as (
    select
      candidate_lines.*,
      case
        when v_medicine_code <> '' and candidate_lines.drug_code_key = v_medicine_code
          then 'exact_code'
        when v_generic_name <> ''
          and candidate_lines.generic_key = v_generic_name
          and (v_strength = '' or candidate_lines.strength_key = v_strength)
          and (v_dosage_form = '' or candidate_lines.dosage_form_key = v_dosage_form)
          then 'same_ingredient'
        else null
      end as overlap_match_type
    from candidate_lines
  )
  select
    case
      when matched_lines.overlap_match_type = 'exact_code' then 'strong_warning'
      else 'warning'
    end::text as severity,
    matched_lines.overlap_match_type::text as match_type,
    matched_lines.drug_code_key::text as medicine_code,
    matched_lines.description::text as medicine_description,
    matched_lines.dispensed_date::date as previous_dispensed_date,
    (matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date as coverage_end_date,
    greatest(((matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date - v_service_date), 0)::integer as remaining_days,
    case
      when p_current_organization_id is not null and matched_lines.organization_id = p_current_organization_id
        then 'This HealthFlow facility'
      else 'Another participating HealthFlow facility'
    end::text as source_label,
    case
      when p_current_organization_id is not null and matched_lines.organization_id = p_current_organization_id
        then coalesce(matched_lines.claim_number, matched_lines.claim_id::text)
      else null
    end::text as previous_claim_reference
  from matched_lines
  where matched_lines.overlap_match_type is not null
    and (matched_lines.dispensed_date + (matched_lines.coverage_days - 1))::date >= v_service_date
  order by
    case when matched_lines.overlap_match_type = 'exact_code' then 0 else 1 end,
    coverage_end_date desc,
    previous_dispensed_date desc
  limit 5;
end;
$$;

revoke all on function public.check_nhis_active_medication_overlap(text, text, text, date, uuid, uuid, text, text, text) from public;
grant execute on function public.check_nhis_active_medication_overlap(text, text, text, date, uuid, uuid, text, text, text) to authenticated;

create index if not exists idx_nhis_drugs_code_generic_strength_form
  on public.nhis_drugs (
    upper(trim(code)),
    lower(regexp_replace(coalesce(generic_name, ''), '\s+', ' ', 'g')),
    lower(regexp_replace(coalesce(strength, ''), '\s+', ' ', 'g')),
    lower(regexp_replace(coalesce(dosage_form, ''), '\s+', ' ', 'g'))
  )
  where is_active = true;
