-- Align supplier and purchase writes with the application's Manage Purchases
-- privilege. Approval remains governed separately by user_can_approve_purchases.
create or replace function public.user_can_manage_purchases()
returns boolean
language sql stable security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid()
      and is_active = true
      and (
        role in ('admin', 'super_admin')
        or coalesce(assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
        or can_manage_purchases = true
      )
  );
$$;
revoke all on function public.user_can_manage_purchases() from public, anon;
grant execute on function public.user_can_manage_purchases() to authenticated;

alter policy suppliers_insert on public.suppliers
with check (organization_id = public.user_organization_id() and public.user_can_manage_purchases());
alter policy suppliers_update on public.suppliers
using (organization_id = public.user_organization_id() and public.user_can_manage_purchases())
with check (organization_id = public.user_organization_id() and public.user_can_manage_purchases());
alter policy purchases_insert on public.purchases
with check (organization_id = public.user_organization_id() and public.user_can_manage_purchases());
alter policy purchases_update on public.purchases
using (organization_id = public.user_organization_id() and public.user_can_manage_purchases())
with check (organization_id = public.user_organization_id() and public.user_can_manage_purchases());
