-- Reapply provider scoping after the later reservation migrations. Preserve
-- cross-provider unresolved and branch guards before any cache lookup.
begin;
do $$
declare definition text;
begin
 definition := pg_get_functiondef('public.reserve_ccc_attendance(uuid,uuid,uuid,text,text,text,date)'::regprocedure);
 definition := replace(definition,
  'and environment=pol.environment and status<>''not_created'';',
  'and environment=pol.environment and provider=pol.provider and status<>''not_created'';');
 definition := replace(definition, ' select * into previous from public.ccc_attendance_requests',
 $guard$ if exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and member_number=p_member and card_type=p_card and attendance_date=p_date and environment=pol.environment and status in ('pending','unknown')) then
  raise exception 'Attendance outcome is unresolved. Reconcile it before retrying with any provider.';
 end if;
 if exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and member_number=p_member and card_type=p_card and attendance_date=p_date and environment=pol.environment and status<>'not_created' and branch_id is distinct from p_branch) then
  raise exception 'Attendance belongs to another branch; reconcile before proceeding';
 end if;
 select * into previous from public.ccc_attendance_requests$guard$);
 if position('provider=pol.provider' in definition)=0 or position('retrying with any provider' in definition)=0 then
  raise exception 'Unexpected attendance reservation definition';
 end if;
 execute definition;
end $$;
notify pgrst,'reload schema';
commit;
