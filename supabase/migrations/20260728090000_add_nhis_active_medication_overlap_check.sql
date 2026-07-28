-- Phase 1 active-medication coverage check for NHIS medicines.
-- Read-only, privacy-minimized RPC. It does not alter CCC, pricing, tariff,
-- duplicate-claim detection, export, submission, or synchronization behavior.

create or replace function public.check_nhis_active_medication_overlap(
  p_member_no text default null,
  p_hin text default null,
  p_medicine_code text default null,
  p_service_date date default current_date,
  p_current_claim_id uuid default null,
  p_current_organization_id uuid default null
)
returns table (
  severity text,
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
  v_service_date date := coalesce(p_service_date, current_date);
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if v_medicine_code = '' or (v_member_no = '' and v_hin = '') then
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
      coalesce(nullif(trim(m.description), ''), trim(m.drug_code), 'Medicine') as description,
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
    where (p_current_claim_id is null or c.id <> p_current_claim_id)
      and upper(trim(coalesce(m.drug_code, ''))) = v_medicine_code
      and coalesce(m.served_qty, m.dispensed_qty, 0) > 0
      and lower(coalesce(m.serving_status, 'fully_served')) not in ('pending', 'not_available', 'not_served')
      and lower(coalesce(c.status, '')) not in ('draft', 'pending_serving', 'serving_in_progress', 'rejected', 'cancelled', 'deleted')
      and (
        (v_member_no <> '' and upper(regexp_replace(coalesce(c.member_no, ''), '[^A-Za-z0-9]', '', 'g')) = v_member_no)
        or
        (v_hin <> '' and upper(regexp_replace(coalesce(c.hin, ''), '[^A-Za-z0-9]', '', 'g')) = v_hin)
      )
  )
  select
    'strong_warning'::text as severity,
    candidate_lines.drug_code_key::text as medicine_code,
    candidate_lines.description::text as medicine_description,
    candidate_lines.dispensed_date::date as previous_dispensed_date,
    (candidate_lines.dispensed_date + (candidate_lines.coverage_days - 1))::date as coverage_end_date,
    greatest(((candidate_lines.dispensed_date + (candidate_lines.coverage_days - 1))::date - v_service_date), 0)::integer as remaining_days,
    case
      when p_current_organization_id is not null and candidate_lines.organization_id = p_current_organization_id
        then 'This HealthFlow facility'
      else 'Another participating HealthFlow facility'
    end::text as source_label,
    case
      when p_current_organization_id is not null and candidate_lines.organization_id = p_current_organization_id
        then coalesce(candidate_lines.claim_number, candidate_lines.claim_id::text)
      else null
    end::text as previous_claim_reference
  from candidate_lines
  where (candidate_lines.dispensed_date + (candidate_lines.coverage_days - 1))::date >= v_service_date
  order by coverage_end_date desc, previous_dispensed_date desc
  limit 5;
end;
$$;

revoke all on function public.check_nhis_active_medication_overlap(text, text, text, date, uuid, uuid) from public;
grant execute on function public.check_nhis_active_medication_overlap(text, text, text, date, uuid, uuid) to authenticated;

create index if not exists idx_nhis_claim_medicines_drug_code_served_coverage
  on public.nhis_claim_medicines (upper(trim(drug_code)), dispensary_date, claim_id)
  where coalesce(served_qty, dispensed_qty, 0) > 0;

create index if not exists idx_nhis_claims_member_hin_status_service
  on public.nhis_claims (
    upper(regexp_replace(coalesce(member_no, ''), '[^A-Za-z0-9]', '', 'g')),
    upper(regexp_replace(coalesce(hin, ''), '[^A-Za-z0-9]', '', 'g')),
    status,
    service_date_from
  );
