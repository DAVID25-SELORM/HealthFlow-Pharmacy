-- Reorder Centre phase 4: advisory branch-transfer options. Read-only; moves no stock.
--
-- For medicines that need restocking in one branch, find the same medicine in the organization's
-- other branches that has stock ABOVE that source row's own reorder level (its "spare"), so a
-- transfer would not push the source branch into low stock. Expired stock is never offered.
--
-- Visibility follows the rest of the app: staff tied to a single branch only ever see their own
-- branch's stock, so they get no rows here. Only organization-level staff (no branch on their
-- profile) see other branches' quantities. Nothing is transferred by this function; a transfer is a
-- separate, explicit action through the existing transfer_drug_to_branch().
begin;

create or replace function public.get_branch_transfer_options(
  p_branch_id uuid,
  p_drug_ids uuid[]
)
returns table (
  target_drug_id uuid,
  source_drug_id uuid,
  source_branch_id uuid,
  source_branch_name text,
  batch_number text,
  expiry_date date,
  source_quantity numeric,
  source_reorder_level numeric,
  spare_quantity numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_org uuid := public.user_organization_id();
  v_user_branch uuid;
begin
  if not public.user_can_manage_purchases() then
    raise exception 'You do not have permission to view branch transfer options.' using errcode = '42501';
  end if;
  if p_branch_id is null then
    raise exception 'Choose a branch.' using errcode = '22023';
  end if;

  -- Branch-bound staff do not see other branches' stock.
  select u.branch_id into v_user_branch from public.users u where u.id = auth.uid();
  if v_user_branch is not null then
    return;
  end if;

  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.organization_id = v_org and b.is_active = true
  ) then
    raise exception 'Selected branch could not be found.' using errcode = '22023';
  end if;

  return query
  select
    t.id,
    s.id,
    s.branch_id,
    b.name::text,
    s.batch_number,
    s.expiry_date,
    s.quantity,
    coalesce(s.reorder_level, 0),
    s.quantity - coalesce(s.reorder_level, 0)
  from public.drugs t
  join public.drugs s
    on s.organization_id = v_org
   and s.branch_id is not null
   and s.branch_id <> p_branch_id
   and s.status = 'active'
   and lower(btrim(s.name)) = lower(btrim(t.name))
  join public.branches b
    on b.id = s.branch_id
   and b.organization_id = v_org
   and b.is_active = true
  where t.organization_id = v_org
    and t.branch_id = p_branch_id
    and t.id = any(coalesce(p_drug_ids, '{}'::uuid[]))
    and s.quantity - coalesce(s.reorder_level, 0) > 0
    and (s.expiry_date is null or s.expiry_date >= current_date)
  order by t.id, (s.quantity - coalesce(s.reorder_level, 0)) desc, b.name;
end;
$$;

revoke all on function public.get_branch_transfer_options(uuid, uuid[]) from public, anon;
grant execute on function public.get_branch_transfer_options(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
