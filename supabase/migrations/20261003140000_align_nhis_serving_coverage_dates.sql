-- Use the same clinical date precedence for the new supply and prior supplies.
begin;
do $migration$
declare
  definition text;
  old_date constant text := 'coalesce(new.dispensary_date, v_claim.service_date_from, current_date)';
  new_date constant text := 'coalesce(public.nhis_medicine_dispensing_date(new.dispensary_date, new.served_at, v_claim.service_date_from), current_date)';
  old_check constant text := 'and new.dispensary_date is not distinct from old.dispensary_date';
  new_check constant text := 'and new.dispensary_date is not distinct from old.dispensary_date
       and new.served_at is not distinct from old.served_at
       and new.nhis_drug_id is not distinct from old.nhis_drug_id';
begin
  select pg_get_functiondef('public.guard_nhis_active_coverage_on_serve()'::regprocedure) into definition;
  if position(new_date in definition) = 0 then
    if position(old_date in definition) = 0 or position(old_check in definition) = 0 then
      raise exception 'Unexpected serving guard; inspect before applying clinical-date correction.';
    end if;
    definition := replace(definition, old_date, new_date);
    definition := replace(definition, old_check, new_check);
    execute definition;
  end if;
end;
$migration$;
notify pgrst, 'reload schema';
commit;
