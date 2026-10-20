begin;
alter table public.organization_nehfams_connection add column environment text not null default 'production' check(environment in ('test','production'));
alter table public.organization_nehfams_connection drop constraint organization_nehfams_connection_pkey;
alter table public.organization_nehfams_connection add primary key(organization_id,environment);
alter table public.organization_nehfams_connection add column expected_hpn text, add column expected_name text,
 add column version integer not null default 1, add column validated_version integer, add column validated_at timestamptz,
 add column auth_mode text, add column otac_required boolean;
alter table public.organization_ccc_policy add column environment text not null default 'production' check(environment in ('test','production'));
alter table public.organization_ccc_policy drop constraint nehfams_generation_disabled;
alter table public.organization_ccc_policy add constraint nehfams_production_disabled check(provider<>'nehfams' or environment='test' or enabled=false);
alter table public.organization_ccc_policy add constraint legacy_production_only check(provider='nehfams' or environment='production');
alter table public.ccc_attendance_requests add column environment text not null default 'production' check(environment in ('test','production'));
drop index public.ccc_one_unresolved_attendance;
create unique index ccc_one_unresolved_attendance on public.ccc_attendance_requests(organization_id,member_number,card_type,attendance_date,environment) where status<>'not_created';

create function public.configure_nehfams_connection(p_org uuid,p_actor uuid,p_environment text,p_key text,p_secret text,p_hpn text,p_name text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare old public.organization_nehfams_connection%rowtype;
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 if p_environment is null or p_environment not in ('test','production') or nullif(btrim(p_hpn),'') is null or nullif(btrim(p_name),'') is null then raise exception 'Environment and expected facility identity required'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 perform 1 from public.organization_ccc_policy where organization_id=p_org for update;
 if exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and status in ('pending','unknown')) then raise exception 'Reconcile unresolved attendance before changing credentials'; end if;
 select * into old from public.organization_nehfams_connection where organization_id=p_org and environment=p_environment for update;
 if nullif(coalesce(p_key,old.api_key_encrypted),'') is null or nullif(coalesce(p_secret,old.api_secret_encrypted),'') is null then raise exception 'Both credentials are required for this environment'; end if;
 insert into public.organization_nehfams_connection(organization_id,environment,api_key_encrypted,api_secret_encrypted,expected_hpn,expected_name,updated_by)
 values(p_org,p_environment,coalesce(p_key,old.api_key_encrypted),coalesce(p_secret,old.api_secret_encrypted),btrim(p_hpn),btrim(p_name),p_actor)
 on conflict(organization_id,environment) do update set api_key_encrypted=excluded.api_key_encrypted,api_secret_encrypted=excluded.api_secret_encrypted,expected_hpn=excluded.expected_hpn,expected_name=excluded.expected_name,version=old.version+1,validated_at=null,validated_version=null,auth_mode=null,otac_required=null,updated_by=p_actor,updated_at=now();
 update public.organization_ccc_policy set provider='nehfams',environment=p_environment,enabled=false,version=version+1,updated_by=p_actor,updated_at=now() where organization_id=p_org;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'configure_nehfams',jsonb_build_object('environment',p_environment));
end $$;
-- Preserve the old entry point for existing clients, always production and disabled.
create or replace function public.save_nehfams_connection(p_org uuid,p_actor uuid,p_key text,p_secret text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare pol public.organization_ccc_policy%rowtype;
begin
 select * into pol from public.organization_ccc_policy where organization_id=p_org;
 perform public.configure_nehfams_connection(p_org,p_actor,'production',p_key,p_secret,pol.expected_hpn,pol.expected_facility_name);
end $$;
create function public.validate_nehfams_connection(p_org uuid,p_actor uuid,p_environment text,p_version integer,p_mode text,p_otac boolean)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 perform 1 from public.organization_ccc_policy where organization_id=p_org for update;
 if p_mode is null or p_mode not in ('1FA','2FA') or p_otac is null or (p_mode='2FA' and not p_otac) then raise exception 'Unsupported authentication configuration'; end if;
 update public.organization_nehfams_connection set validated_at=now(),validated_version=version,auth_mode=p_mode,otac_required=p_otac where organization_id=p_org and environment=p_environment and version=p_version;
 if not found then raise exception 'Connection changed; validate again'; end if;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'validate_nehfams',jsonb_build_object('environment',p_environment,'version',p_version));
end $$;
create function public.activate_nehfams_test(p_org uuid,p_actor uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 perform 1 from public.organization_ccc_policy where organization_id=p_org for update;
 if exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and status in ('pending','unknown')) then raise exception 'Reconcile unresolved attendance'; end if;
 if not exists(select 1 from public.organization_nehfams_connection where organization_id=p_org and environment='test' and validated_version=version and validated_at>now()-interval '24 hours') then raise exception 'Validate the test connection first'; end if;
 update public.organization_ccc_policy set provider='nehfams',environment='test',enabled=true,version=version+1,updated_by=p_actor,updated_at=now() where organization_id=p_org;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'activate_nehfams_test','{}');
end $$;
create or replace function public.reserve_ccc_attendance(p_org uuid,p_actor uuid,p_branch uuid,p_encounter text,p_member text,p_card text,p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare pol public.organization_ccc_policy%rowtype; previous public.ccc_attendance_requests%rowtype; request_id uuid; connection public.organization_nehfams_connection%rowtype;
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
  if pol.environment<>'test' or connection.validated_at is null or connection.validated_at<now()-interval '24 hours' or connection.validated_version is distinct from connection.version then raise exception 'Validate the NeHFAMS test connection before generation'; end if;
 end if;
 if pol.provider='otac' and (pol.token_encrypted is null or pol.token_expires_at<=now() or pol.token_expires_at is null or nullif(pol.expected_hpn,'') is null or nullif(pol.expected_facility_name,'') is null) then raise exception 'OTAC connection needs configuration or token renewal'; end if;
 insert into public.ccc_attendance_requests(organization_id,branch_id,actor_id,encounter_key,member_number,card_type,attendance_date,provider,policy_version,environment)
 values(p_org,p_branch,p_actor,p_encounter,p_member,p_card,p_date,pol.provider,pol.version,pol.environment) returning id into request_id;
 return jsonb_build_object('cached',false,'request_id',request_id,'policy',to_jsonb(pol),'connection',case when pol.provider='nehfams' then to_jsonb(connection) else null end);
end $$;

create or replace function public.save_ccc_policy(p_org uuid,p_actor uuid,p_provider text,p_enabled boolean,p_token text,p_expiry timestamptz,p_hpn text,p_name text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare old public.organization_ccc_policy%rowtype;
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 if p_provider is null or p_provider not in ('existing','otac') then raise exception 'Use dedicated NeHFAMS configuration'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 select * into old from public.organization_ccc_policy where organization_id=p_org for update;
 if p_provider<>old.provider and exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and status in ('pending','unknown')) then raise exception 'Reconcile unresolved attendance requests before switching provider'; end if;
 update public.organization_ccc_policy set provider=p_provider,environment='production',enabled=p_enabled,
 token_encrypted=coalesce(p_token,old.token_encrypted),token_expires_at=coalesce(p_expiry,old.token_expires_at),
 expected_hpn=nullif(btrim(p_hpn),''),expected_facility_name=nullif(btrim(p_name),''),version=old.version+1,updated_by=p_actor,updated_at=now() where organization_id=p_org;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'configure',jsonb_build_object('from',old.provider,'to',p_provider,'enabled',p_enabled,'token_replaced',p_token is not null,'expected_hpn',p_hpn,'expected_facility_name',p_name));
end $$;

alter table public.nhis_claims add column ccc_attendance_request_id uuid references public.ccc_attendance_requests(id);
create index nhis_claim_attendance_link on public.nhis_claims(ccc_attendance_request_id) where ccc_attendance_request_id is not null;
create function public.check_claim_attendance_link() returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare r public.ccc_attendance_requests%rowtype;
begin
 if new.ccc_attendance_request_id is null then return new; end if;
 select * into r from public.ccc_attendance_requests where id=new.ccc_attendance_request_id;
 if not found or r.organization_id is distinct from new.organization_id or r.branch_id is distinct from new.branch_id or r.member_number is distinct from new.member_no or r.status<>'succeeded' or r.environment<>'production' or r.attendance_date is distinct from new.service_date_from::date or r.result->>'ccCode' is distinct from new.ccc_no then raise exception 'Claim does not match a confirmed production attendance in this facility and branch'; end if;
 return new;
end $$;
create trigger check_claim_attendance_link before insert or update on public.nhis_claims for each row execute function public.check_claim_attendance_link();
revoke all on function public.configure_nehfams_connection(uuid,uuid,text,text,text,text,text),public.validate_nehfams_connection(uuid,uuid,text,integer,text,boolean),public.activate_nehfams_test(uuid,uuid),public.check_claim_attendance_link() from public,anon,authenticated;
grant execute on function public.configure_nehfams_connection(uuid,uuid,text,text,text,text,text),public.validate_nehfams_connection(uuid,uuid,text,integer,text,boolean),public.activate_nehfams_test(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
