-- Subscription lifecycle metadata and a role-authorized facility projection.
-- Expiry never changes facility status, deletes data, or blocks clinical work.
begin;

alter table public.organizations
  add column if not exists subscription_grace_days integer not null default 30,
  add column if not exists manual_grace_until timestamptz,
  add column if not exists subscription_restricted_at timestamptz,
  add column if not exists subscription_suspended_at timestamptz,
  add column if not exists subscription_updated_by uuid references public.users(id) on delete set null;

create or replace function public.guard_subscription_metadata()
returns trigger language plpgsql security definer set search_path = public, pg_catalog
as $$
begin
  if (new.billing_status is distinct from old.billing_status
      or new.plan_code is distinct from old.plan_code
      or new.subscription_tier is distinct from old.subscription_tier
      or new.trial_ends_at is distinct from old.trial_ends_at
      or new.subscription_ends_at is distinct from old.subscription_ends_at
      or new.manual_grace_until is distinct from old.manual_grace_until
      or new.subscription_grace_days is distinct from old.subscription_grace_days
      or new.subscription_restricted_at is distinct from old.subscription_restricted_at
      or new.subscription_suspended_at is distinct from old.subscription_suspended_at
      or new.last_payment_at is distinct from old.last_payment_at
      or new.next_payment_due_at is distinct from old.next_payment_due_at
      or new.billing_notes is distinct from old.billing_notes)
     and not exists (select 1 from public.users where id = auth.uid()
       and is_active is distinct from false and role = 'super_admin') then
    raise exception 'Only platform administrators may change subscription details.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_subscription_metadata on public.organizations;
create trigger guard_subscription_metadata before update on public.organizations
for each row execute function public.guard_subscription_metadata();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_subscription_grace_days_check') then
    alter table public.organizations add constraint organizations_subscription_grace_days_check
      check (subscription_grace_days between 0 and 365);
  end if;
end $$;

create or replace function public.get_my_subscription()
returns jsonb
language plpgsql security definer
set search_path = public, pg_catalog
as $$
declare v_user public.users%rowtype; v_org public.organizations%rowtype; v_now timestamptz := now();
  v_expiry timestamptz; v_grace timestamptz; v_state text;
begin
  select * into v_user from public.users where id = auth.uid() and is_active is distinct from false;
  if not found or v_user.organization_id is null then
    raise exception 'Subscription details are unavailable.' using errcode = '42501';
  end if;
  if not (v_user.role in ('admin','pharmacist','super_admin') or
          coalesce(v_user.assigned_roles, '{}'::text[]) && array['admin','pharmacist','super_admin']::text[]) then
    raise exception 'Subscription details are restricted.' using errcode = '42501';
  end if;
  select * into v_org from public.organizations where id = v_user.organization_id;
  if not found then raise exception 'Subscription details are unavailable.' using errcode = '42501'; end if;
  v_expiry := case when v_org.status = 'trial' then v_org.trial_ends_at else v_org.subscription_ends_at end;
  v_grace := greatest(coalesce(v_org.manual_grace_until, '-infinity'::timestamptz),
    coalesce(v_expiry + make_interval(days => v_org.subscription_grace_days), '-infinity'::timestamptz));
  v_state := case
    when v_org.status in ('suspended','cancelled') or v_org.billing_status in ('suspended','cancelled') then 'suspended'
    when v_expiry is null or v_now <= v_expiry then 'active'
    when v_now <= v_grace then 'grace'
    else 'overdue' end;
  return jsonb_build_object('organization_id',v_org.id,'plan_code',v_org.plan_code,
    'subscription_tier',v_org.subscription_tier,'state',v_state,
    'expires_at',v_expiry,'grace_ends_at',nullif(v_grace,'-infinity'::timestamptz),
    'manual_grace_until',v_org.manual_grace_until);
end $$;

revoke all on function public.get_my_subscription() from public, anon, authenticated;
grant execute on function public.get_my_subscription() to authenticated;

notify pgrst, 'reload schema';
commit;
