-- The policy lives in pharmacy_settings. Correct the restoration lock without
-- replacing any other deployed logic or changing access permissions.
begin;
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef('public.apply_nhis_recycle_stock(uuid,uuid)'::regprocedure) into definition;
  if position('from public.facility_settings where organization_id = v_claim.organization_id for share' in definition) = 0 then
    raise exception 'Unexpected NHIS recycle stock helper; inspect before applying this migration.';
  end if;
  execute replace(definition,
    'from public.facility_settings where organization_id = v_claim.organization_id for share',
    'from public.pharmacy_settings where organization_id = v_claim.organization_id for share');
end;
$migration$;
notify pgrst, 'reload schema';
commit;
