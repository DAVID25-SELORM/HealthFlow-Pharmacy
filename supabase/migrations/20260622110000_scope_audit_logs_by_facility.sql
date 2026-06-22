-- Scope activity logs by facility so facility admins can see their own staff activity
-- without exposing other tenants' logs.

alter table public.audit_logs
  add column if not exists organization_id uuid references public.organizations(id);

create index if not exists idx_audit_logs_organization_created_at
  on public.audit_logs(organization_id, created_at desc);

create index if not exists idx_audit_logs_actor_user_created_at
  on public.audit_logs(actor_user_id, created_at desc);

update public.audit_logs logs
set organization_id = users.organization_id
from public.users users
where logs.organization_id is null
  and logs.actor_user_id = users.id
  and users.organization_id is not null;

create or replace function public.log_audit_event(
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_details jsonb default '{}'::jsonb,
  p_organization_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid;
  actor_mail text;
  actor_organization_id uuid;
begin
  actor_id := auth.uid();
  actor_mail := auth.email();

  select organization_id
  into actor_organization_id
  from public.users
  where id = actor_id;

  insert into public.audit_logs (
    actor_user_id,
    actor_email,
    event_type,
    entity_type,
    entity_id,
    action,
    details,
    organization_id,
    created_at
  )
  values (
    actor_id,
    actor_mail,
    p_event_type,
    p_entity_type,
    p_entity_id,
    p_action,
    coalesce(p_details, '{}'::jsonb),
    coalesce(p_organization_id, actor_organization_id),
    now()
  );
end;
$$;

grant execute on function public.log_audit_event(text, text, uuid, text, jsonb, uuid) to authenticated;

drop policy if exists audit_logs_select_pharmacist_admin on public.audit_logs;
drop policy if exists audit_logs_select_facility_activity on public.audit_logs;
drop policy if exists audit_logs_insert_own_activity on public.audit_logs;

create policy audit_logs_select_facility_activity on public.audit_logs
for select to authenticated
using (
  exists (
    select 1
    from public.users viewer
    where viewer.id = auth.uid()
      and viewer.is_active is distinct from false
      and (
        viewer.role in ('admin', 'super_admin', 'branch_manager')
        or coalesce(viewer.can_view_activity_log, false) = true
        or coalesce(viewer.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'branch_manager']::text[]
      )
      and (
        audit_logs.organization_id = viewer.organization_id
        or exists (
          select 1
          from public.users actor
          where actor.id = audit_logs.actor_user_id
            and actor.organization_id = viewer.organization_id
        )
      )
  )
);

create policy audit_logs_insert_own_activity on public.audit_logs
for insert to authenticated
with check (
  actor_user_id = auth.uid()
  and exists (
    select 1
    from public.users actor
    where actor.id = auth.uid()
      and actor.organization_id = audit_logs.organization_id
  )
);
