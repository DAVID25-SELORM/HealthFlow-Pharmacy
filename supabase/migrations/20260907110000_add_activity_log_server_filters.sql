-- Claims-officer activity must be filtered before pagination.  This keeps a
-- monthly search complete instead of searching only the most recently loaded
-- audit-log page.  The functions are Edge-function-only: the Edge function
-- establishes the requester and tenant before invoking them with service-role
-- credentials, so they are not exposed to browser clients.

create index if not exists idx_audit_logs_organization_actor_created_at
  on public.audit_logs (organization_id, actor_user_id, created_at desc);

create or replace function public.get_activity_log_page(
  p_organization_id uuid,
  p_from_date date default null,
  p_to_date date default null,
  p_actor_user_id uuid default null,
  p_event_type text default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 100
)
returns table (
  id uuid,
  actor_user_id uuid,
  actor_email text,
  actor_name text,
  actor_is_active boolean,
  event_type text,
  entity_type text,
  action text,
  details jsonb,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 100), 1), 500);
  v_search text := nullif(lower(btrim(p_search)), '');
  v_event_type text := nullif(btrim(p_event_type), '');
  v_from timestamptz;
  v_to_exclusive timestamptz;
begin
  if p_organization_id is null then
    raise exception 'An organization is required to read facility activity logs.' using errcode = '22023';
  end if;

  if p_to_date is not null and p_from_date is not null and p_to_date < p_from_date then
    raise exception 'The activity-log end date cannot be before the start date.' using errcode = '22007';
  end if;

  -- Ghana has no daylight-saving adjustment, but the explicit zone documents
  -- and preserves the facility calendar-day contract at the database boundary.
  if p_from_date is not null then
    v_from := p_from_date::timestamp at time zone 'Africa/Accra';
  end if;
  if p_to_date is not null then
    v_to_exclusive := (p_to_date + 1)::timestamp at time zone 'Africa/Accra';
  end if;

  return query
  with scoped_logs as (
    select logs.*
    from public.audit_logs logs
    where (
      logs.organization_id = p_organization_id
      or (
        logs.organization_id is null
        and exists (
          select 1
          from public.users historical_actor
          where historical_actor.id = logs.actor_user_id
            and historical_actor.organization_id = p_organization_id
        )
      )
    )
  ), filtered_logs as (
    select
      logs.id,
      logs.actor_user_id,
      logs.actor_email,
      staff.full_name as actor_name,
      staff.is_active as actor_is_active,
      logs.event_type,
      logs.entity_type,
      logs.action,
      logs.details,
      logs.created_at
    from scoped_logs logs
    left join public.users staff on staff.id = logs.actor_user_id
    where (p_actor_user_id is null or logs.actor_user_id = p_actor_user_id)
      and (v_event_type is null or logs.event_type = v_event_type)
      and (v_from is null or logs.created_at >= v_from)
      and (v_to_exclusive is null or logs.created_at < v_to_exclusive)
      and (
        v_search is null
        or lower(concat_ws(' ',
          staff.full_name,
          logs.actor_email,
          logs.event_type,
          logs.entity_type,
          logs.action,
          logs.details::text
        )) like '%' || v_search || '%'
      )
  )
  select
    filtered_logs.id,
    filtered_logs.actor_user_id,
    filtered_logs.actor_email,
    filtered_logs.actor_name,
    filtered_logs.actor_is_active,
    filtered_logs.event_type,
    filtered_logs.entity_type,
    filtered_logs.action,
    filtered_logs.details,
    filtered_logs.created_at,
    count(*) over () as total_count
  from filtered_logs
  order by filtered_logs.created_at desc, filtered_logs.id desc
  offset (v_page - 1) * v_page_size
  limit v_page_size;
end;
$$;

create or replace function public.get_activity_log_filter_options(
  p_organization_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, pg_catalog
as $$
  with scoped_logs as (
    select logs.actor_user_id, logs.event_type
    from public.audit_logs logs
    where logs.organization_id = p_organization_id
       or (
         logs.organization_id is null
         and exists (
           select 1
           from public.users historical_actor
           where historical_actor.id = logs.actor_user_id
             and historical_actor.organization_id = p_organization_id
         )
       )
  ), claims_officers as (
    -- Include disabled staff and historic actors.  The option value remains
    -- their immutable user ID; the name/email are display text only.
    select distinct staff.id, staff.full_name, staff.email, staff.is_active
    from public.users staff
    where staff.organization_id = p_organization_id
      and (
        staff.role = 'claims_officer'
        or coalesce(staff.assigned_roles, '{}'::text[]) @> array['claims_officer']::text[]
        or exists (select 1 from scoped_logs logs where logs.actor_user_id = staff.id)
      )
  )
  select jsonb_build_object(
    'actors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', officers.id,
        'full_name', officers.full_name,
        'email', officers.email,
        'is_active', officers.is_active
      ) order by lower(coalesce(officers.full_name, officers.email, '')), officers.id)
      from claims_officers officers
    ), '[]'::jsonb),
    'event_types', coalesce((
      select jsonb_agg(events.event_type order by lower(events.event_type))
      from (
        select distinct scoped_logs.event_type
        from scoped_logs
        where nullif(btrim(scoped_logs.event_type), '') is not null
      ) events
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_activity_log_page(uuid, date, date, uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.get_activity_log_filter_options(uuid) from public, anon, authenticated;
grant execute on function public.get_activity_log_page(uuid, date, date, uuid, text, text, integer, integer) to service_role;
grant execute on function public.get_activity_log_filter_options(uuid) to service_role;

comment on function public.get_activity_log_page(uuid, date, date, uuid, text, text, integer, integer) is
  'Returns one tenant-scoped, Ghana-calendar activity-log page after all filters and before pagination. Called only by tier-access.';
comment on function public.get_activity_log_filter_options(uuid) is
  'Returns tenant-scoped claims-officer and canonical event filter options, including inactive historic staff.';

notify pgrst, 'reload schema';
