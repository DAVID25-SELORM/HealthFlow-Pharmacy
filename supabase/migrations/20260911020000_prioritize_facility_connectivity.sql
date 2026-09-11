-- Canonical heartbeat status and deterministic whole-facility ordering.
-- No pagination: all facilities are ordered before JSON aggregation.
begin;
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
    'serverWindowSeconds', 900, 'recentlyActiveWindowSeconds', 1800, 'facilities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'connectivityStatus', evidence.status, 'lastSeen', evidence.last_seen,
        'id', o.id, 'name', o.name, 'accountStatus', o.status,
        'lastBrowserContact', bc.last_seen,
        'recentSessions', coalesce(bc.sessions, 0),
        'recentStaff', coalesce(bc.staff, 0),
        'lastServerContact', sc.last_seen,
        'recentServers', coalesce(sc.recent, 0),
        'registeredServers', coalesce(sc.registered, 0)
      ) order by case evidence.status
          when 'ONLINE' then 1 when 'RECENTLY_ACTIVE' then 2
          when 'ATTENTION_REQUIRED' then 3 when 'OFFLINE' then 4 else 5 end,
        evidence.last_seen desc nulls last, lower(o.name) collate "C", o.name collate "C", o.id)
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
      cross join lateral (
        select greatest(bc.last_seen, sc.last_seen) last_seen,
          case
            when bc.last_seen >= now() - interval '3 minutes'
              or sc.last_seen >= now() - interval '15 minutes' then 'ONLINE'
            when greatest(bc.last_seen, sc.last_seen) >= now() - interval '30 minutes' then 'RECENTLY_ACTIVE'
            when greatest(bc.last_seen, sc.last_seen) is null then 'NEVER_CONNECTED'
            when sc.registered > 0 then 'ATTENTION_REQUIRED'
            else 'OFFLINE'
          end status
      ) evidence
    ), '[]'::jsonb));
end;
$$;
revoke all on function public.get_facility_connectivity() from public, anon;
grant execute on function public.get_facility_connectivity() to authenticated;
notify pgrst, 'reload schema';
commit;
