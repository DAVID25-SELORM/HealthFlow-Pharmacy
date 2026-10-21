-- NeHFAMS production enablement, one approved facility at a time. NOT applied anywhere by the change that adds it.
--
-- Production NeHFAMS attendance stays impossible for every facility until a platform administrator records an approval
-- (with the NHIA authorization reference and a hard attendance limit) for that facility. The limit is consumed inside
-- the same transaction that reserves each attendance, so a rolled-back reservation does not use it up and concurrent
-- reservations cannot exceed it. A deployment flag (NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED) is a separate kill switch.
begin;

create table public.nehfams_production_approval (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 approved_by uuid not null references public.users(id),
 approved_at timestamptz not null default now(),
 nhia_reference text not null check(length(btrim(nhia_reference)) between 10 and 300),
 attendance_limit integer not null check(attendance_limit between 1 and 100),
 attendances_used integer not null default 0 check(attendances_used >= 0),
 revoked_at timestamptz
);
alter table public.nehfams_production_approval enable row level security;
revoke all on public.nehfams_production_approval from public,anon,authenticated;
grant all on public.nehfams_production_approval to service_role;

-- The blanket "never enabled in production" CHECK becomes a rule that needs an active, unexhausted approval.
alter table public.organization_ccc_policy drop constraint nehfams_production_disabled;
create function public.guard_nehfams_production_policy() returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if new.provider='nehfams' and new.environment='production' and new.enabled then
  if not exists(select 1 from public.nehfams_production_approval a where a.organization_id=new.organization_id and a.revoked_at is null and a.attendances_used<a.attendance_limit) then
   raise exception 'NeHFAMS production is not approved for this facility, or its approved attendance limit is used up';
  end if;
 end if;
 return new;
end $$;
create trigger guard_nehfams_production_policy before insert or update on public.organization_ccc_policy for each row execute function public.guard_nehfams_production_policy();

create function public.approve_nehfams_production(p_org uuid,p_actor uuid,p_reference text,p_limit integer default 1)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 if nullif(btrim(p_reference),'') is null or length(btrim(p_reference)) not between 10 and 300 then raise exception 'Record the NHIA authorization reference (10-300 characters)'; end if;
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Attendance limit must be between 1 and 100'; end if;
 if not exists(select 1 from public.organizations where id=p_org) then raise exception 'Unknown facility'; end if;
 insert into public.nehfams_production_approval(organization_id,approved_by,nhia_reference,attendance_limit)
 values(p_org,p_actor,btrim(p_reference),p_limit)
 on conflict(organization_id) do update set approved_by=excluded.approved_by,approved_at=now(),nhia_reference=excluded.nhia_reference,attendance_limit=excluded.attendance_limit,attendances_used=0,revoked_at=null;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'approve_nehfams_production',jsonb_build_object('limit',p_limit,'reference',btrim(p_reference)));
end $$;

create function public.revoke_nehfams_production(p_org uuid,p_actor uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 perform 1 from public.organization_ccc_policy where organization_id=p_org for update;
 update public.nehfams_production_approval set revoked_at=now() where organization_id=p_org and revoked_at is null;
 update public.organization_ccc_policy set enabled=false,version=version+1,updated_by=p_actor,updated_at=now() where organization_id=p_org and provider='nehfams' and environment='production' and enabled;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'revoke_nehfams_production','{}');
end $$;

create function public.activate_nehfams_production(p_org uuid,p_actor uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare approval public.nehfams_production_approval%rowtype;
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 perform 1 from public.organization_ccc_policy where organization_id=p_org for update;
 if exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and status in ('pending','unknown')) then raise exception 'Reconcile unresolved attendance'; end if;
 select * into approval from public.nehfams_production_approval where organization_id=p_org for update;
 if not found or approval.revoked_at is not null or approval.attendances_used>=approval.attendance_limit then raise exception 'NeHFAMS production is not approved for this facility, or its approved attendance limit is used up'; end if;
 if not exists(select 1 from public.organization_nehfams_connection where organization_id=p_org and environment='production' and validated_version=version and validated_at>now()-interval '24 hours') then raise exception 'Validate the production connection first'; end if;
 update public.organization_ccc_policy set provider='nehfams',environment='production',enabled=true,version=version+1,updated_by=p_actor,updated_at=now() where organization_id=p_org;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'activate_nehfams_production',jsonb_build_object('limit',approval.attendance_limit,'used',approval.attendances_used));
end $$;

-- Same function as 20261021090000 except: production is allowed for an approved facility with a validated connection,
-- and each new production reservation consumes one approved attendance atomically.
create or replace function public.reserve_ccc_attendance(p_org uuid,p_actor uuid,p_branch uuid,p_encounter text,p_member text,p_card text,p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare pol public.organization_ccc_policy%rowtype; previous public.ccc_attendance_requests%rowtype; request_id uuid; connection public.organization_nehfams_connection%rowtype; approval public.nehfams_production_approval%rowtype;
begin
 if not exists(select 1 from public.users where id=p_actor and organization_id=p_org and is_active=true) then raise exception 'Facility membership required'; end if;
 if exists(select 1 from public.users where id=p_actor and branch_id is not null and branch_id is distinct from p_branch) then raise exception 'Branch membership required'; end if;
 if p_branch is not null and not exists(select 1 from public.branches where id=p_branch and organization_id=p_org) then raise exception 'Invalid branch'; end if;
 if nullif(btrim(p_encounter),'') is null or length(p_encounter)>200 or p_member is null or length(p_member) not between 8 and 30 or p_card is null or p_card not in ('NHISCARD','GHANACARD') or p_date is distinct from (now() at time zone 'Africa/Accra')::date then raise exception 'CCC generation requires a current attendance and valid encounter'; end if;
 if exists(select 1 from public.nhis_claims where id::text=p_encounter and (organization_id is distinct from p_org or member_no is distinct from p_member)) then raise exception 'Encounter does not match this facility/member'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 select * into pol from public.organization_ccc_policy where organization_id=p_org for update;
 if pol.provider not in ('existing','otac','nehfams') then raise exception 'Unsupported CCC provider'; end if;
 if not pol.enabled then raise exception 'CCC generation is disabled for this facility'; end if;
 select * into previous from public.ccc_attendance_requests where organization_id=p_org and member_number=p_member and card_type=p_card and attendance_date=p_date and environment=pol.environment and status<>'not_created';
 if found then
  if previous.branch_id is distinct from p_branch then raise exception 'Attendance belongs to another branch; reconcile before proceeding'; end if;
  if previous.status='succeeded' then return jsonb_build_object('cached',true,'result',previous.result,'request_id',previous.id,'environment',previous.environment); end if;
  raise exception 'Attendance outcome is unresolved. Ask the platform administrator to reconcile it before retrying or switching providers.';
 end if;
 if pol.provider='nehfams' then
  select * into connection from public.organization_nehfams_connection where organization_id=p_org and environment=pol.environment for update;
  if connection.validated_at is null or connection.validated_at<now()-interval '24 hours' or connection.validated_version is distinct from connection.version then raise exception 'Validate the NeHFAMS connection before generation'; end if;
  if pol.environment='production' then
   select * into approval from public.nehfams_production_approval where organization_id=p_org for update;
   if not found or approval.revoked_at is not null or approval.attendances_used>=approval.attendance_limit then raise exception 'NeHFAMS production is not approved for this facility, or its approved attendance limit is used up'; end if;
  end if;
 end if;
 if pol.provider='otac' and (pol.token_encrypted is null or pol.token_expires_at<=now() or pol.token_expires_at is null or nullif(pol.expected_hpn,'') is null or nullif(pol.expected_facility_name,'') is null) then raise exception 'OTAC connection needs configuration or token renewal'; end if;
 insert into public.ccc_attendance_requests(organization_id,branch_id,actor_id,encounter_key,member_number,card_type,attendance_date,provider,policy_version,environment)
 values(p_org,p_branch,p_actor,p_encounter,p_member,p_card,p_date,pol.provider,pol.version,pol.environment) returning id into request_id;
 if pol.provider='nehfams' and pol.environment='production' then
  update public.nehfams_production_approval set attendances_used=attendances_used+1 where organization_id=p_org;
 end if;
 return jsonb_build_object('cached',false,'request_id',request_id,'policy',to_jsonb(pol),'connection',case when pol.provider='nehfams' then to_jsonb(connection) else null end);
end $$;

revoke all on function public.guard_nehfams_production_policy(),public.approve_nehfams_production(uuid,uuid,text,integer),public.revoke_nehfams_production(uuid,uuid),public.activate_nehfams_production(uuid,uuid) from public,anon,authenticated;
grant execute on function public.approve_nehfams_production(uuid,uuid,text,integer),public.revoke_nehfams_production(uuid,uuid),public.activate_nehfams_production(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
