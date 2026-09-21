-- Read-only predeployment inventory. No identifiers or patient values returned.
begin read only;
set local statement_timeout = '30s';
with medicine as (
  select claim_id, sum(total_amount) amount,
    bool_or(unit_price is null or dispensed_qty is null or total_amount is null or unit_price < 0 or dispensed_qty < 0 or round(unit_price*dispensed_qty,2)<>total_amount) invalid_lines,
    bool_or(nullif(btrim(drug_code),'') is null) missing_code
  from public.nhis_claim_medicines group by claim_id
), service as (
  select claim_id,sum(total_amount) amount,
    bool_or(unit_price is null or quantity is null or total_amount is null or unit_price < 0 or quantity <= 0 or round(unit_price*quantity,2)<>total_amount) invalid_lines,
    bool_or(coalesce(tariff_version,'') not in ('FEB 2023','2023-02-01.250531')) unknown_version
  from public.nhis_claim_services group by claim_id
), issues as (
  select c.status,c.total_amount,
    coalesce(m.amount,0)+coalesce(s.amount,0) as line_amount,
    coalesce(m.invalid_lines,false) as invalid_medicines,coalesce(s.invalid_lines,false) as invalid_services,
    coalesce(s.unknown_version,false) as unknown_service_version,
    coalesce(m.missing_code,false) as missing_medicine_code,
    nullif(btrim(c.ccc_no),'') is null as missing_ccc,
    c.service_date_from is null or c.service_date_to<c.service_date_from as invalid_dates,
    nullif(c.prescription_file_path,'') is null as missing_prescription_reference
  from public.nhis_claims c left join medicine m on m.claim_id=c.id left join service s on s.claim_id=c.id
)
select count(*) as scanned,
  count(*) filter(where total_amount is distinct from line_amount) as invalid_totals,
  count(*) filter(where invalid_medicines) as invalid_medicine_lines,
  count(*) filter(where invalid_services) as invalid_service_lines,
  count(*) filter(where unknown_service_version) as unknown_service_versions,
  count(*) filter(where missing_medicine_code) as missing_medicine_codes,
  count(*) filter(where missing_ccc) as missing_ccc,
  count(*) filter(where invalid_dates) as invalid_dates,
  count(*) filter(where missing_prescription_reference) as missing_prescription_references,
  count(*) filter(where status in ('submitted','accepted','approved','paid')) as historical_submission_review,
  0 as automatically_repaired, 0 as would_update
from issues;

select count(*) as configurations,
  count(*) filter(where accreditation_date_generated is null) as missing_generated_date,
  count(*) filter(where accreditation_date_generated>current_date) as future_generated_date,
  count(*) filter(where accreditation_date_generated=accreditation_expiry_date) as generated_equals_expiry,
  count(*) filter(where nullif(credential_code,'') is null) as missing_credential
from public.nhia_configuration where is_active;

-- Existence, not claimed trustworthiness: ordinary log payloads are caller-controlled.
select event_type,count(*) as events from public.audit_logs
where entity_type='nhis_claims' and (event_type ilike '%sign%' or event_type ilike '%valid%' or event_type ilike '%export%')
group by event_type order by event_type;
rollback;
