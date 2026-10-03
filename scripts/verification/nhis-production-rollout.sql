-- READ ONLY. One result set to export as CSV; no patient records or credentials.
with expected(trigger_name, table_name) as (
  values ('guard_nhis_active_coverage_on_serve','public.nhis_claim_medicines'),
         ('guard_nhis_coverage_claim_edit','public.nhis_claims')
), checks as (
  select 'trigger'::text as check_type, e.trigger_name as name,
    jsonb_build_object('table',e.table_name,'present',t.oid is not null,
      'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) as details
  from expected e left join pg_trigger t
    on t.tgname=e.trigger_name and t.tgrelid=to_regclass(e.table_name) and not t.tgisinternal
  union all
  select 'branch_summary','Active branch registrations',
    jsonb_build_object('count',count(*),'note','Registrations do not prove installed coverage guards')
  from public.branch_sync_clients where is_active=true
  union all
  select 'active_branch',o.name || ' / ' || c.name,
    jsonb_build_object('registration_id',c.id,'last_seen_at',c.last_seen_at,
      'inventory_protocol_version',c.nhis_inventory_protocol_version,
      'coverage_rollout_status','Online-only installation verification required')
  from public.branch_sync_clients c
  join public.organizations o on o.id=c.organization_id
  where c.is_active=true
)
select check_type,name,details from checks order by check_type,name;
