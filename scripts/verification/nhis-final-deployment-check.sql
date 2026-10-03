-- READ ONLY: returns schema definitions and registration counts, never patient data.
-- Presence/marker checks are deployment checks, not substitutes for behavior tests.
with expected_functions(signature) as (
  values
    ('public.guard_nhis_active_coverage_on_serve()'),
    ('public.guard_nhis_coverage_claim_edit()'),
    ('public.guard_nhis_same_claim_supply()'),
    ('public.lock_nhis_coverage_identifiers(text,text)'),
    ('public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)'),
    ('public.nhis_medicine_dispensing_date(date,timestamp with time zone,date)')
), functions as (
  select e.signature,p.oid,p.prosecdef,pg_get_functiondef(p.oid) as definition
  from expected_functions e left join pg_proc p on p.oid=to_regprocedure(e.signature)
), expected_triggers(name,table_name,function_name,event_mask) as (
  values
    ('guard_nhis_active_coverage_on_serve','public.nhis_claim_medicines','public.guard_nhis_active_coverage_on_serve()',23),
    ('guard_nhis_coverage_claim_edit','public.nhis_claims','public.guard_nhis_coverage_claim_edit()',17),
    ('guard_nhis_same_claim_supply','public.nhis_claim_medicines','public.guard_nhis_same_claim_supply()',21)
), checks as (
  select 'function'::text as check_type,signature as name,
    jsonb_build_object('present',oid is not null,'security_definer',prosecdef,
      'anon_can_execute',has_function_privilege('anon',oid,'EXECUTE'),
      'authenticated_can_execute',has_function_privilege('authenticated',oid,'EXECUTE'),
      'definition',definition) as details
  from functions
  union all
  select 'trigger',e.name,
    jsonb_build_object('present',t.oid is not null,'enabled',t.tgenabled,
      'correct_function',t.tgfoid=to_regprocedure(e.function_name),
      'correct_events',t.tgtype=e.event_mask,
      'definition',pg_get_triggerdef(t.oid))
  from expected_triggers e left join pg_trigger t
    on t.tgname=e.name and t.tgrelid=to_regclass(e.table_name) and not t.tgisinternal
  union all
  select 'branch_summary','Active branch registrations',jsonb_build_object('count',count(*))
  from public.branch_sync_clients where is_active=true
)
select check_type,name,details from checks order by check_type,name;
