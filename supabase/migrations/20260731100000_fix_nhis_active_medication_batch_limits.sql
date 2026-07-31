-- Remove the active-medication export scrub batch cap.
--
-- The single-claim checker still returns at most 5 advisories per medicine.
-- This wrapper must not cap the whole export at 100 rows, otherwise busy
-- monthly batches can hide later active-medication warnings.
--
-- Advisory only; no CCC, pricing, tariff, duplicate, export format,
-- submission, installer, branch-token, or sync behavior is changed.

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
  recommended_action text
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
    overlap.recommended_action
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
