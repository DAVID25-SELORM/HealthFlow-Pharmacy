-- Run in Supabase SQL Editor. Read-only: no claims, dates, stock or CCCs change.
-- Result 1: confirm that the online serving protections exist and are enabled.
begin transaction read only;
select expected.table_name, expected.trigger_name,
       coalesce(t.tgenabled in ('O','A'), false) as enabled
from (values
  ('nhis_claim_medicines','guard_nhis_active_coverage_on_serve'),
  ('nhis_claim_medicines','guard_nhis_same_claim_supply'),
  ('nhis_claims','guard_nhis_coverage_claim_edit')
) expected(table_name,trigger_name)
left join pg_trigger t on t.tgname=expected.trigger_name
  and t.tgrelid=to_regclass('public.' || expected.table_name) and not t.tgisinternal;

-- Result 2: after the injection fix, the first two results must be NULL;
-- the capsule result must remain 1.
select public.nhis_coverage_dose_units('5000','5000 IU/mL','injection','Heparin injection') as bare_injection_units,
       public.nhis_coverage_dose_units('5000','','','') as unknown_form_units,
       public.nhis_coverage_dose_units('200 mg','200 mg','capsule','Fluconazole capsule') as capsule_units;

-- Result 3: fill in the patient's member number and/or HIN below.
-- Empty identifiers deliberately return no patient records.
-- Includes all recorded medicines, not just a presumed matching medicine.
with parameters as (
  select ''::text as member_no, ''::text as hin,
         date '2026-09-01' as from_date, date '2026-10-08' as through_date
), matched_claims as (
  select c.* from public.nhis_claims c cross join parameters p
  where coalesce(c.service_date_from,c.created_at::date) between p.from_date and p.through_date
    and ((nullif(btrim(p.member_no),'') is not null and
      upper(regexp_replace(coalesce(c.member_no,''),'[^A-Za-z0-9]','','g')) =
      upper(regexp_replace(p.member_no,'[^A-Za-z0-9]','','g')))
    or (nullif(btrim(p.hin),'') is not null and
      upper(regexp_replace(coalesce(c.hin,''),'[^A-Za-z0-9]','','g')) =
      upper(regexp_replace(p.hin,'[^A-Za-z0-9]','','g'))))
)
select c.id as claim_id, c.claim_number, o.name as facility, c.status as claim_status,
       c.service_date_from as claim_date, c.created_at as claim_created_at,
       m.id as medicine_id, m.drug_code, m.description, d.generic_name, d.strength, d.dosage_form,
       m.dispensary_date, coalesce(m.dispensary_date,c.service_date_from,c.created_at::date) as effective_dispensing_date,
       m.prescribed_qty, m.served_qty, m.dispensed_qty, m.serving_status,
       m.dose, m.frequency, m.duration, m.served_at,
       public.nhis_coverage_dose_units(m.dose,d.strength,d.dosage_form,m.description) as interpreted_dose_units
from matched_claims c
join public.nhis_claim_medicines m on m.claim_id=c.id
left join public.organizations o on o.id=c.organization_id
left join lateral (
  select nd.generic_name,nd.strength,nd.dosage_form from public.nhis_drugs nd
  where nd.organization_id=c.organization_id and
    (nd.id=m.nhis_drug_id or upper(btrim(nd.code))=upper(btrim(m.drug_code)))
  order by (nd.id=m.nhis_drug_id) desc nulls last, nd.id limit 1
) d on true
order by effective_dispensing_date,c.created_at,c.id,m.id;
commit;
