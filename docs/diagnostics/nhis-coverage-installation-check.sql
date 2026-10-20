-- Read-only deployment verification. Contains no patient identifiers.
select p.proname, p.oid::regprocedure::text as signature,
  position('nhis_coverage_dose_units' in pg_get_functiondef(p.oid)) > 0 as uses_dose_conversion
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('check_nhis_active_medication_overlap','get_nhis_patient_active_medications');
select c.relname as table_name, t.tgname, t.tgenabled
from pg_trigger t join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and not t.tgisinternal
and t.tgname in ('guard_nhis_active_coverage_on_serve','guard_nhis_coverage_claim_edit','guard_nhis_same_claim_supply');
select public.nhis_coverage_dose_units('90 mg','30 mg (GITS)','tablet','Nifedipine Tablet') as expected_three_units;
