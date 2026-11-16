-- BRANCH-002: server-side branch scope for stock and sales.
--
-- Until now the stock and sales tables were readable by everyone in the pharmacy (organization_id only), so
-- "staff see their own branch" was a rule the app applied, not one the database kept. This adds restrictive
-- row-level-security policies so a member of staff who belongs to a branch can read and change only that
-- branch's stock and sales, even when calling the API directly.
--
-- Who is limited (public.user_branch_scope() returns the branch id, or NULL for "not limited"):
--   * the user belongs to a branch, and
--   * is not an administrator or super administrator (by role or by any assigned role), and
--   * the pharmacy has Multi-branch switched on, and
--   * the pharmacy has MORE THAN ONE active branch.
-- Everyone else (administrators, staff with no branch, pharmacies without Multi-branch, single-branch
-- pharmacies, and the service role used by the edge functions and the branch server) is not limited.
--
-- Rows that carry no branch (older pharmacies keep their whole stock this way) stay visible: they are
-- organisation-level, and hiding them would empty a pharmacy's lists.
--
-- Restrictive policies are ANDed with the existing permissive ones, so every existing rule still applies.
-- SECURITY DEFINER functions (sales, refunds, transfers) are owned by the table owner and are not subject
-- to row-level security, so their behaviour is unchanged; the trigger at the end covers sale updates.
-- Additive: no data is changed. Undo with 03-rollback.sql.
begin;

do $$
begin
  if to_regclass('public.branch_stock_transfers') is null then
    raise exception 'Apply the confirmed branch stock transfer migration (20261111090000) first.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Who is limited, and to which branch
-- ---------------------------------------------------------------------------
create or replace function public.user_branch_scope()
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select u.branch_id
  from public.users u
  join public.organizations o on o.id = u.organization_id
  where u.id = auth.uid()
    and u.branch_id is not null
    and coalesce(u.role::text, '') not in ('admin', 'super_admin')
    and coalesce(u.assigned_roles::text, '') !~ '\m(admin|super_admin)\M'
    and coalesce(o.can_use_multi_branch, false)
    and (select count(*) from public.branches b
          where b.organization_id = u.organization_id and b.is_active) > 1
$$;

revoke all on function public.user_branch_scope() from public, anon;
grant execute on function public.user_branch_scope() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Restrictive policies
--    (select public.user_branch_scope()) is evaluated once per statement, not once per row.
-- ---------------------------------------------------------------------------
drop policy if exists drugs_branch_scope on public.drugs;
create policy drugs_branch_scope on public.drugs
  as restrictive for all to authenticated
  using (
    (select public.user_branch_scope()) is null
    or branch_id is null
    or branch_id = (select public.user_branch_scope())
  )
  with check (
    (select public.user_branch_scope()) is null
    or branch_id is null
    or branch_id = (select public.user_branch_scope())
  );

drop policy if exists sales_branch_scope on public.sales;
create policy sales_branch_scope on public.sales
  as restrictive for all to authenticated
  using (
    (select public.user_branch_scope()) is null
    or branch_id is null
    or branch_id = (select public.user_branch_scope())
  )
  with check (
    (select public.user_branch_scope()) is null
    or branch_id is null
    or branch_id = (select public.user_branch_scope())
  );

-- Sale lines follow their sale (the sales policies apply inside this check).
drop policy if exists sale_items_branch_scope on public.sale_items;
create policy sale_items_branch_scope on public.sale_items
  as restrictive for select to authenticated
  using (
    (select public.user_branch_scope()) is null
    or exists (select 1 from public.sales s where s.id = sale_items.sale_id)
  );

-- A stock movement belongs to the branch it left and, for a transfer, the branch it reached.
drop policy if exists stock_movements_branch_scope on public.stock_movements;
create policy stock_movements_branch_scope on public.stock_movements
  as restrictive for select to authenticated
  using (
    (select public.user_branch_scope()) is null
    or branch_id is null
    or branch_id = (select public.user_branch_scope())
    or destination_branch_id = (select public.user_branch_scope())
  );

-- A transfer is visible to the two branches it connects.
drop policy if exists branch_stock_transfers_branch_scope on public.branch_stock_transfers;
create policy branch_stock_transfers_branch_scope on public.branch_stock_transfers
  as restrictive for select to authenticated
  using (
    (select public.user_branch_scope()) is null
    or source_branch_id = (select public.user_branch_scope())
    or destination_branch_id = (select public.user_branch_scope())
  );

drop policy if exists branch_stock_transfer_items_branch_scope on public.branch_stock_transfer_items;
create policy branch_stock_transfer_items_branch_scope on public.branch_stock_transfer_items
  as restrictive for select to authenticated
  using (
    (select public.user_branch_scope()) is null
    or exists (select 1 from public.branch_stock_transfers t where t.id = branch_stock_transfer_items.transfer_id)
  );

-- ---------------------------------------------------------------------------
-- 3. A sale of another branch cannot be changed (a refund updates the sale)
--    Runs for every update of a sale; it does nothing for anyone who is not limited.
-- ---------------------------------------------------------------------------
create or replace function public.guard_sale_branch_update()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_scope uuid := public.user_branch_scope();
begin
  if v_scope is not null and old.branch_id is not null and old.branch_id <> v_scope then
    raise exception 'You can only change sales of your own branch.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_sale_branch_update() from public, anon;

drop trigger if exists sales_branch_guard on public.sales;
create trigger sales_branch_guard
  before update on public.sales
  for each row execute function public.guard_sale_branch_update();

notify pgrst, 'reload schema';
commit;
