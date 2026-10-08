begin;

create or replace function public.manage_purchase_supplier(p_supplier_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_supplier public.suppliers%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.users u where u.id = auth.uid() and u.is_active = true
      and u.organization_id = public.user_organization_id()
      and (u.role in ('admin','super_admin') or
        coalesce((to_jsonb(u)->>'can_manage_purchases')::boolean,
          u.role in ('pharmacist','procurement','inventory_officer','branch_manager')))
  ) then raise exception 'You do not have permission to manage suppliers.' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('suspend','reactivate','delete') then
    raise exception 'Invalid supplier action.' using errcode = '22023';
  end if;
  select * into v_supplier from public.suppliers
    where id = p_supplier_id and organization_id = public.user_organization_id() for update;
  if not found then raise exception 'Supplier not found or access denied.' using errcode = '42501'; end if;
  if p_action = 'delete' then
    if exists (select 1 from public.purchases where supplier_id = p_supplier_id) then
      raise exception 'This supplier has purchase history. Suspend the supplier instead.' using errcode = '23503';
    end if;
    delete from public.suppliers where id = p_supplier_id;
  else
    update public.suppliers set is_active = (p_action = 'reactivate'), updated_at = now()
      where id = p_supplier_id returning * into v_supplier;
  end if;
  return to_jsonb(v_supplier);
end $$;
revoke all on function public.manage_purchase_supplier(uuid,text) from public, anon;
grant execute on function public.manage_purchase_supplier(uuid,text) to authenticated;

-- Reject stale selections on new orders while preserving existing order history.
create or replace function public.guard_purchase_supplier_active()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_active boolean;
begin
  if tg_op = 'UPDATE' and new.supplier_id is not distinct from old.supplier_id
    and new.organization_id is not distinct from old.organization_id then return new; end if;
  if new.supplier_id is null then return new; end if;
  select is_active into v_active from public.suppliers
    where id = new.supplier_id and organization_id = new.organization_id for share;
  if not found or not coalesce(v_active,false) then
    raise exception 'Select an active supplier. This supplier is suspended or unavailable.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_purchase_supplier_active on public.purchases;
create trigger guard_purchase_supplier_active before insert or update of supplier_id, organization_id on public.purchases
  for each row execute function public.guard_purchase_supplier_active();
revoke all on function public.guard_purchase_supplier_active() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
