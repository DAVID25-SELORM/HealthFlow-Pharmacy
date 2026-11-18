begin;
alter table public.organization_ccc_policy drop constraint organization_ccc_policy_provider_check;
alter table public.organization_ccc_policy add constraint organization_ccc_policy_provider_check check (provider in ('existing','otac','nehfams'));
alter table public.organization_ccc_policy add constraint nehfams_live_disabled check (provider <> 'nehfams' or enabled = false);
-- Separate metadata only. Credentials and token columns wait for the official contract.
create table public.organization_nehfams_configuration (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 contract_status text not null default 'pending' check (contract_status='pending'),
 connection_validated boolean not null default false check (connection_validated=false)
);
alter table public.organization_nehfams_configuration enable row level security;
revoke all on public.organization_nehfams_configuration from public,anon,authenticated;
grant all on public.organization_nehfams_configuration to service_role;
create or replace function public.reserve_ccc_attendance(p_org uuid,p_actor uuid,p_branch uuid,p_encounter text,p_member text,p_card text,p_date date)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare pol public.organization_ccc_policy%rowtype; previous public.ccc_attendance_requests%rowtype; request_id uuid;
begin
 if not exists(select 1 from public.users where id=p_actor and organization_id=p_org and is_active=true) then raise exception 'Facility membership required'; end if;
 if p_branch is not null and not exists(select 1 from public.branches where id=p_branch and organization_id=p_org) then raise exception 'Invalid branch'; end if;
 if nullif(btrim(p_encounter),'') is null or length(p_encounter)>200 or p_member is null or length(p_member) not between 8 and 30 or p_card not in ('NHISCARD','GHANACARD') or p_date is distinct from (now() at time zone 'Africa/Accra')::date then raise exception 'CCC generation requires a current attendance and valid encounter'; end if;
 if exists(select 1 from public.nhis_claims where id::text=p_encounter and (organization_id is distinct from p_org or member_no is distinct from p_member)) then raise exception 'Encounter does not match this facility/member'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 select * into pol from public.organization_ccc_policy where organization_id=p_org for update;
 if pol.provider not in ('existing','otac') then raise exception 'CCC provider is not available for live requests'; end if;
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

create or replace function public.save_ccc_policy(p_org uuid,p_actor uuid,p_provider text,p_enabled boolean,p_token text,p_expiry timestamptz,p_hpn text,p_name text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare old public.organization_ccc_policy%rowtype;
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 if p_provider is null or p_provider not in ('existing','otac','nehfams') or p_enabled is null then raise exception 'Invalid CCC provider configuration'; end if;
 if p_provider='nehfams' and (p_enabled or p_token is not null or p_expiry is not null) then raise exception 'NeHFAMS live configuration is unavailable'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 select * into old from public.organization_ccc_policy where organization_id=p_org for update;
 if p_provider<>old.provider and exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and status in ('pending','unknown')) then raise exception 'Reconcile unresolved attendance requests before switching provider'; end if;
 update public.organization_ccc_policy set provider=p_provider,enabled=p_enabled,
 token_encrypted=coalesce(p_token,old.token_encrypted),token_expires_at=coalesce(p_expiry,old.token_expires_at),
 expected_hpn=case when p_provider='nehfams' then old.expected_hpn else nullif(btrim(p_hpn),'') end,expected_facility_name=case when p_provider='nehfams' then old.expected_facility_name else nullif(btrim(p_name),'') end,version=old.version+1,updated_by=p_actor,updated_at=now() where organization_id=p_org;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'configure',jsonb_build_object('from',old.provider,'to',p_provider,'enabled',p_enabled,'token_replaced',p_token is not null,'expected_hpn',p_hpn,'expected_facility_name',p_name));
end $$;

-- Function replacement preserves existing service-only grants.
notify pgrst,'reload schema';
commit;
