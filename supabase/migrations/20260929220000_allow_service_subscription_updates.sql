-- Tenant administration validates the platform administrator in the Edge Function,
-- then writes with the trusted service role (which has no auth.uid()).
-- Keep direct authenticated/anonymous subscription edits protected.
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
     and auth.role() is distinct from 'service_role'
     and not exists (select 1 from public.users where id = auth.uid()
       and is_active is distinct from false and role = 'super_admin') then
    raise exception 'Only platform administrators may change subscription details.' using errcode = '42501';
  end if;
  return new;
end $$;
