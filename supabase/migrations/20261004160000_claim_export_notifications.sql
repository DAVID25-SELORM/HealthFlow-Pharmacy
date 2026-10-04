-- Durable monthly CXF export alerts and private SMTP outbox. No patient details in alerts.
begin;
create table public.claim_export_alerts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 artifact_sha256 text not null, period date not null, facility_name text not null, claim_count integer not null,
 created_at timestamptz not null default now(), unique(organization_id,artifact_sha256,period)
);
create table public.claim_export_alert_reads (
 alert_id uuid references public.claim_export_alerts(id) on delete cascade, user_id uuid references public.users(id),
 primary key(alert_id,user_id)
);
create table public.claim_export_mail_queue (
 id uuid primary key default gen_random_uuid(), alert_id uuid not null references public.claim_export_alerts(id),
 recipient text not null, status text not null default 'pending' check(status in ('pending','sending','sent','failed')),
 attempts integer not null default 0, available_at timestamptz not null default now(), lease uuid,
 sent_at timestamptz, last_error text, unique(alert_id,recipient)
);
alter table public.claim_export_alerts enable row level security;
alter table public.claim_export_alert_reads enable row level security;
alter table public.claim_export_mail_queue enable row level security;
revoke all on public.claim_export_alerts,public.claim_export_alert_reads,public.claim_export_mail_queue from public,anon,authenticated;
create function public.complete_claim_export_alert(p_claim_ids uuid[],p_hash text) returns void
language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_org uuid; v_alert uuid; v_group record; v_count integer;
begin
 select organization_id into v_org from public.users where id=auth.uid() and is_active=true;
 if not found or v_org is null then raise exception 'Active facility membership required.' using errcode='42501'; end if;
 if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or cardinality(p_claim_ids) is null or cardinality(p_claim_ids) not between 1 and 10000 then
  raise exception 'Invalid export manifest.';
 end if;
 select count(distinct c.id) into v_count from public.nhis_claims c
 where c.id=any(p_claim_ids) and c.organization_id=v_org and c.service_date_from is not null
 and exists(select 1 from public.nhis_cxf_events e where e.claim_id=c.id and e.organization_id=v_org
   and e.artifact_sha256=p_hash and e.actor_id=auth.uid() and e.event_type in ('CXF_EXPORTED','CXF_REEXPORTED'));
 if v_count<>cardinality(p_claim_ids) then raise exception 'The entire export must be audited before notifications are queued.' using errcode='42501'; end if;
 -- All audited claims in this artifact must be included: no partial batch alerts.
 if (select count(distinct claim_id) from public.nhis_cxf_events where organization_id=v_org and artifact_sha256=p_hash
     and event_type in ('CXF_EXPORTED','CXF_REEXPORTED'))<>v_count then raise exception 'Incomplete export manifest.'; end if;
 for v_group in select date_trunc('month',c.service_date_from)::date as period,count(*) as n
   from public.nhis_claims c where c.id=any(p_claim_ids) group by 1 loop
  insert into public.claim_export_alerts(organization_id,artifact_sha256,period,facility_name,claim_count)
  values(v_org,p_hash,v_group.period,(select name from public.organizations where id=v_org),v_group.n)
  on conflict do nothing returning id into v_alert;
  if v_alert is not null then
   insert into public.claim_export_mail_queue(alert_id,recipient)
   select v_alert,recipient from (
    select lower(btrim(email)) recipient from public.users where organization_id=v_org and is_active=true
     and (role='admin' or coalesce(assigned_roles,'{}') && array['admin']::text[])
    union select 'daventratech@gmail.com'
   ) recipients where recipient ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' on conflict do nothing;
  end if;
 end loop;
end $$;
create function public.list_claim_export_alerts(p_read_id uuid default null) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare u public.users%rowtype;
begin
 select * into u from public.users where id=auth.uid() and is_active=true;
 if not found or not coalesce(u.role='super_admin' or u.role='admin' or coalesce(u.assigned_roles,'{}') && array['admin']::text[],false) then
  raise exception 'Administrator required.' using errcode='42501'; end if;
 if p_read_id is not null then
  insert into public.claim_export_alert_reads select a.id,u.id from public.claim_export_alerts a
  where a.id=p_read_id and (u.role='super_admin' or a.organization_id=u.organization_id) on conflict do nothing;
 end if;
 return coalesce((select jsonb_agg(to_jsonb(x)) from (
  select a.id,a.facility_name,a.period,a.claim_count,a.created_at from public.claim_export_alerts a
  where (u.role='super_admin' or a.organization_id=u.organization_id)
   and not exists(select 1 from public.claim_export_alert_reads r where r.alert_id=a.id and r.user_id=u.id)
  order by a.created_at desc limit 100
 ) x),'[]'::jsonb);
end $$;
create function public.claim_export_mail_batch() returns setof jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 update public.claim_export_mail_queue set status='failed',lease=null,last_error='Delivery lease expired after five attempts; review before retrying.' where status='sending' and attempts>=5 and available_at<=now();
 return query with jobs as (
 select id from public.claim_export_mail_queue where status in ('pending','sending') and available_at<=now() and attempts<5
 order by available_at for update skip locked limit 2
 ), leased as (
 update public.claim_export_mail_queue q set status='sending',attempts=attempts+1,lease=gen_random_uuid(),available_at=now()+interval '10 minutes'
 from jobs where q.id=jobs.id returning q.*
 ) select jsonb_build_object('id',q.id,'lease',q.lease,'recipient',q.recipient,'facility',a.facility_name,'period',a.period,
 'claim_count',a.claim_count,'exported_at',a.created_at) from leased q join public.claim_export_alerts a on a.id=q.alert_id;
end $$;
create function public.finish_claim_export_mail(p_id uuid,p_lease uuid,p_success boolean) returns void
language sql security definer set search_path=public,pg_catalog as $$
 update public.claim_export_mail_queue set status=case when p_success then 'sent' when attempts>=5 then 'failed' else 'pending' end,
 sent_at=case when p_success then now() else null end,last_error=case when p_success then null else 'SMTP delivery failed; inspect worker logs.' end,
 available_at=now()+interval '5 minutes',lease=null where id=p_id and lease=p_lease and status='sending';
$$;
revoke all on function public.complete_claim_export_alert(uuid[],text),public.list_claim_export_alerts(uuid),public.claim_export_mail_batch(),public.finish_claim_export_mail(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.complete_claim_export_alert(uuid[],text),public.list_claim_export_alerts(uuid) to authenticated;
grant execute on function public.claim_export_mail_batch(),public.finish_claim_export_mail(uuid,uuid,boolean) to service_role;
notify pgrst,'reload schema';
commit;

