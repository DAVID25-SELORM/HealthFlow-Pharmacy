begin;
alter table public.organization_ccc_policy drop constraint organization_ccc_policy_provider_check;
alter table public.organization_ccc_policy add constraint organization_ccc_policy_provider_check check(provider in ('existing','otac','nehfams'));
alter table public.organization_ccc_policy add constraint nehfams_generation_disabled check(provider <> 'nehfams' or enabled=false);
create table public.organization_nehfams_connection (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 api_key_encrypted text not null check(length(api_key_encrypted)>0),
 api_secret_encrypted text not null check(length(api_secret_encrypted)>0),
 updated_by uuid not null references public.users(id), updated_at timestamptz not null default now()
);
alter table public.organization_nehfams_connection enable row level security;
revoke all on public.organization_nehfams_connection from public,anon,authenticated;
grant all on public.organization_nehfams_connection to service_role;
create function public.save_nehfams_connection(p_org uuid,p_actor uuid,p_key text,p_secret text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare previous public.organization_ccc_policy%rowtype; saved public.organization_nehfams_connection%rowtype;
begin
 if not exists(select 1 from public.users where id=p_actor and role='super_admin' and is_active=true) then raise exception 'Platform administrator required'; end if;
 insert into public.organization_ccc_policy(organization_id) values(p_org) on conflict do nothing;
 select * into previous from public.organization_ccc_policy where organization_id=p_org for update;
 if exists(select 1 from public.ccc_attendance_requests where organization_id=p_org and status in ('pending','unknown')) then raise exception 'Reconcile unresolved attendance before selecting NeHFAMS'; end if;
 select * into saved from public.organization_nehfams_connection where organization_id=p_org;
 if nullif(coalesce(p_key,saved.api_key_encrypted),'') is null or nullif(coalesce(p_secret,saved.api_secret_encrypted),'') is null then raise exception 'NeHFAMS API key and secret are required'; end if;
 insert into public.organization_nehfams_connection(organization_id,api_key_encrypted,api_secret_encrypted,updated_by)
 values(p_org,coalesce(p_key,saved.api_key_encrypted),coalesce(p_secret,saved.api_secret_encrypted),p_actor)
 on conflict(organization_id) do update set api_key_encrypted=excluded.api_key_encrypted,api_secret_encrypted=excluded.api_secret_encrypted,updated_by=p_actor,updated_at=now();
 -- Preserve all existing OTAC credentials and facility identity fields.
 update public.organization_ccc_policy set provider='nehfams',enabled=false,version=version+1,updated_by=p_actor,updated_at=now() where organization_id=p_org;
 insert into public.ccc_policy_audit(organization_id,actor_id,action,details) values(p_org,p_actor,'configure',jsonb_build_object('from',previous.provider,'to','nehfams','enabled',false,'api_key_replaced',p_key is not null,'api_secret_replaced',p_secret is not null));
end $$;
revoke all on function public.save_nehfams_connection(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.save_nehfams_connection(uuid,uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
