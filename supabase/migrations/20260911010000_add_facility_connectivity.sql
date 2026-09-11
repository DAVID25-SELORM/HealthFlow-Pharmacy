-- Connection evidence only. No patient data, device fingerprints or IPs.
begin;
create table public.facility_browser_contacts (
  user_id uuid not null references public.users(id) on delete cascade,
  session_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, session_id)
);
create index facility_browser_contacts_org_seen
  on public.facility_browser_contacts (organization_id, last_seen_at desc);
alter table public.facility_browser_contacts enable row level security;
revoke all on public.facility_browser_contacts from public, anon, authenticated;

create or replace function public.record_facility_browser_contact()
returns void language plpgsql security definer
set search_path = public, pg_catalog
as $$
declare
  v_user uuid := auth.uid();
  v_session uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  v_org uuid;
begin
  select u.organization_id into v_org from public.users u
  where u.id = v_user and u.is_active is true and u.role <> 'super_admin';
  if v_org is null or v_session is null then
    raise exception 'An active facility staff session is required.' using errcode = '42501';
  end if;
  -- Identity and time come from the verified session/server, never the body.
  insert into public.facility_browser_contacts as existing
    (user_id, session_id, organization_id, last_seen_at)
  values (v_user, v_session, v_org, now())
  on conflict (user_id, session_id) do update
    set organization_id = excluded.organization_id, last_seen_at = now()
    where existing.last_seen_at < now() - interval '30 seconds'
       or existing.organization_id <> excluded.organization_id;
  -- Bounded per-user history; stale sessions never count as current.
  delete from public.facility_browser_contacts
    where user_id = v_user and last_seen_at < now() - interval '30 days';
end;
$$;

create or replace function public.get_facility_connectivity()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
begin
  if not exists (select 1 from public.users u where u.id = auth.uid()
    and u.is_active is true and u.role = 'super_admin') then
    raise exception 'Platform administrator access is required.' using errcode = '42501';
  end if;
  return jsonb_build_object('checkedAt', now(), 'browserWindowSeconds', 180,
    'serverWindowSeconds', 900, 'facilities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'name', o.name, 'accountStatus', o.status,
        'lastBrowserContact', bc.last_seen,
        'recentSessions', coalesce(bc.sessions, 0),
        'recentStaff', coalesce(bc.staff, 0),
        'lastServerContact', sc.last_seen,
        'recentServers', coalesce(sc.recent, 0),
        'registeredServers', coalesce(sc.registered, 0)
      ) order by o.name, o.id)
      from public.organizations o
      left join lateral (
        select max(c.last_seen_at) last_seen,
          count(*) filter (where c.last_seen_at >= now() - interval '3 minutes') sessions,
          count(distinct c.user_id) filter (where c.last_seen_at >= now() - interval '3 minutes') staff
        from public.facility_browser_contacts c
        join public.users u on u.id = c.user_id and u.organization_id = c.organization_id
          and u.is_active is true and u.role <> 'super_admin'
        where c.organization_id = o.id
      ) bc on true
      left join lateral (
        select max(c.last_seen_at) last_seen, count(*) registered,
          count(*) filter (where c.last_seen_at >= now() - interval '15 minutes') recent
        from public.branch_sync_clients c
        join public.branches b on b.id = c.branch_id and b.organization_id = c.organization_id
          and b.is_active is true
        where c.organization_id = o.id and c.is_active is true
      ) sc on true
    ), '[]'::jsonb));
end;
$$;
revoke all on function public.record_facility_browser_contact() from public, anon;
revoke all on function public.get_facility_connectivity() from public, anon;
grant execute on function public.record_facility_browser_contact() to authenticated;
grant execute on function public.get_facility_connectivity() to authenticated;
notify pgrst, 'reload schema';
commit;
