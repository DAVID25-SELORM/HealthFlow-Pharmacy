begin;
create table public.organization_ccc_policy (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 provider text not null default 'existing' check(provider in ('existing','otac')),
 enabled boolean not null default true,
 token_encrypted text, token_expires_at timestamptz, expected_hpn text, expected_facility_name text,
 version integer not null default 1, updated_by uuid references public.users(id), updated_at timestamptz not null default now()
);
create table public.ccc_attendance_requests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 branch_id uuid references public.branches(id), actor_id uuid not null references public.users(id),
 encounter_key text not null, member_number text not null, card_type text not null, attendance_date date not null,
 provider text not null, policy_version integer not null,
 status text not null default 'pending' check(status in ('pending','succeeded','unknown','not_created')),
 result jsonb, error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index ccc_one_unresolved_attendance on public.ccc_attendance_requests(organization_id,member_number,card_type,attendance_date)
 where status <> 'not_created';
create table public.ccc_policy_audit (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 actor_id uuid not null references public.users(id), action text not null, details jsonb not null, created_at timestamptz not null default now()
);
alter table public.organization_ccc_policy enable row level security;
alter table public.ccc_attendance_requests enable row level security;
alter table public.ccc_policy_audit enable row level security;
revoke all on public.organization_ccc_policy,public.ccc_attendance_requests,public.ccc_policy_audit from public,anon,authenticated;
grant all on public.organization_ccc_policy,public.ccc_attendance_requests,public.ccc_policy_audit to service_role;

-- Service-only entry points: the edge authenticates the actor, and SQL checks ownership again.
create function public.reserve_ccc_attendance(p_org uuid,p_actor uuid,p_branch uuid,p_encounter text,p_member text,p_card text,p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare pol public.organization_ccc_policy%rowtype; previous public.ccc_attendance_requests%rowtype; request_id uuid;
begin
 if not exists(select 1 from public.users where id=p_actor and organization_id=p_org and is_active=true) then raise exception 'Facility membership required'; end if;
 if p_branch is not null and not exists(select 1 from public.branches where id=p_branch and organization_id=p_org) then raise exception 'Invalid branch'; end if;
 if nullif(btrim(p_encounter),'') is null or length(p_encounter)>200 or p_member is null or length(p_member) not between 8 and 30 or p_card not in ('NHISCARD','GHANACARD') or p_date is distinct from (now() at time zone 'Africa/Accra')::date then raise exception 'CCC generation requires a current attendance and valid encounter'; end if;
 if exists(select 1 from public.nhis_claims where id::text=p_encounter and (organization_id is distinct from p_org or member_no is distinct from p_member)) then raise exception 'Encounter does not match this facility/member'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 select * into pol from public.organization_ccc_policy where organization_id=p_org for update;
 if not pol.enabled then raise exception 'CCC generation is disabled for this facility'; end if;
 select * into previous from public.ccc_attendance_requests where organization_id=p_org and member_number=p_member and card_type=p_card and attendance_date=p_date and status<>'not_created';
 if found then
  if previous.status='succeeded' then return jsonb_build_object('cached',true,'result',previous.result,'request_id',previous.id); end if;
  raise exception 'Attendance outcome is unresolved. Ask the platform administrator to reconcile it before retrying or switching providers.';
 end if;
 if pol.provider='otac' and (pol.token_encrypted is null or pol.token_expires_at<=now() or pol.token_expires_at is null or nullif(pol.expected_hpn,'') is null or nullif(pol.expected_facility_name,'') is null) then raise exception 'OTAC connection needs configuration or token renewal'; end if;
 insert into public.ccc_attendance_requests(organization_id,branch_id,actor_id,encounter_key,member_number,card_type,attendance_date,provider,policy_version)
 values(p_org,p_branch,p_actor,p_encounter,p_member,p_card,p_date,pol.provider,pol.version) returning id into request_id;
 return jsonb_build_object('cached',false,'request_id',request_id,'policy',to_jsonb(pol));
end $$;

create function public.save_ccc_policy(p_org uuid,p_actor uuid,p_provider text,p_enabled boolean,p_token text,p_expiry timestamptz,p_hpn text,p_name text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare old public.organization_ccc_policy%rowtype;
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 select * into old from public.organization_ccc_policy where organization_id=p_org for update;
 if p_provider<>old.provider and exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and status in ('pending','unknown')) then raise exception 'Reconcile unresolved attendance requests before switching provider'; end if;
 update public.organization_ccc_policy set provider=p_provider,enabled=p_enabled,
 token_encrypted=coalesce(p_token,old.token_encrypted),token_expires_at=coalesce(p_expiry,old.token_expires_at),
 expected_hpn=nullif(btrim(p_hpn),''),expected_facility_name=nullif(btrim(p_name),''),version=old.version+1,updated_by=p_actor,updated_at=now() where organization_id=p_org;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'configure',jsonb_build_object('from',old.provider,'to',p_provider,'enabled',p_enabled,'token_replaced',p_token is not null,'expected_hpn',p_hpn,'expected_facility_name',p_name));
end $$;
revoke all on function public.reserve_ccc_attendance(uuid,uuid,uuid,text,text,text,date),public.save_ccc_policy(uuid,uuid,text,boolean,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.reserve_ccc_attendance(uuid,uuid,uuid,text,text,text,date),public.save_ccc_policy(uuid,uuid,text,boolean,text,timestamptz,text,text) to service_role;

-- Branch token never grants policy management or token access.
create function public.ccc_branch_actor(p_sync_token text,p_actor uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare client record; u public.users%rowtype;
begin
 client:=public.get_branch_sync_client(p_sync_token);
 select * into u from public.users where id=p_actor and organization_id=client.organization_id and is_active=true;
 if not found or (u.branch_id is not null and u.branch_id<>client.branch_id) then raise exception 'Branch membership required'; end if;
 return jsonb_build_object('id',u.id,'organization_id',client.organization_id,'branch_id',client.branch_id);
end $$;
revoke all on function public.ccc_branch_actor(text,uuid) from public,anon,authenticated;
grant execute on function public.ccc_branch_actor(text,uuid) to service_role;
-- A human must verify the actual NHIA outcome; a timeout alone is never proof of failure.
create function public.reconcile_ccc_attendance(p_org uuid,p_actor uuid,p_id uuid,p_note text,p_result jsonb default null)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare r public.ccc_attendance_requests%rowtype;
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 if nullif(btrim(p_note),'') is null or length(btrim(p_note)) not between 20 and 1000 then raise exception 'Record NHIA verification evidence (20-1000 characters)'; end if;
 perform 1 from public.organization_ccc_policy where organization_id=p_org for update;
 select * into r from public.ccc_attendance_requests where id=p_id and organization_id=p_org for update;
 if not found or r.status not in ('pending','unknown') or r.created_at>now()-interval '5 minutes' then raise exception 'Only unresolved requests older than five minutes can be reconciled'; end if;
 if p_result is not null and (
   coalesce(p_result->>'ccCode','') !~ '^[0-9]{5}$' or
   coalesce(p_result#>>'{memberDetails,authId}','')='' or
   coalesce(p_result#>>'{memberDetails,hpName}','')='' or
   (p_result#>>'{memberDetails,attendanceDate}') is distinct from r.attendance_date::text
 ) then raise exception 'Provide the verified NHIA attendance code, ID, facility and matching date'; end if;
 update public.ccc_attendance_requests set status=case when p_result is null then 'not_created' else 'succeeded' end,
 result=p_result,error_code=null,updated_at=now() where id=p_id;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'reconcile',jsonb_build_object('request_id',p_id,'outcome',case when p_result is null then 'not_created' else 'succeeded' end,'evidence',p_note));
end $$;
revoke all on function public.reconcile_ccc_attendance(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.reconcile_ccc_attendance(uuid,uuid,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
