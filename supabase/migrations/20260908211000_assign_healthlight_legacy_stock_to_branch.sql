-- HEALTH LIGHT LTD created its first branch after recording inventory.
-- POS filters on branch_id, so older unassigned stock is no longer visible.
-- Preserve drug IDs, quantities, prices and historical references. Do not
-- merge batches or move positive stock that already belongs to a branch.
-- Diagnostics confirmed a zero-stock branch duplicate of the legacy batch.
-- Unassign that empty record first; keep both IDs and all references intact.
do $$
declare
  v_branch public.branches%rowtype;
  v_count integer;
  v_empty_count integer;
begin
  -- Serialize against branch creation and stock edits during this repair.
  lock table public.branches in share row exclusive mode;
  lock table public.drugs in share row exclusive mode;

  select * into v_branch
  from public.branches
  where id = 'f0907191-dcb9-4958-b377-c03abb3e2891'::uuid;

  -- Other environments do not contain this production branch.
  if not found then
    return;
  end if;

  if v_branch.is_active is distinct from true
     or v_branch.name is distinct from 'KORLE-BU' then
    raise exception 'HEALTHLIGHT stock repair: expected active KORLE-BU branch.';
  end if;

  if exists (
    select 1 from public.branches b
    where b.organization_id = v_branch.organization_id
      and b.id <> v_branch.id
  ) then
    raise exception 'HEALTHLIGHT stock repair: multiple branches exist; review stock allocation first.';
  end if;

  if exists (
    select 1
    from public.drugs legacy
    join public.drugs assigned
      on assigned.organization_id = legacy.organization_id
     and assigned.branch_id = v_branch.id
     and assigned.name = legacy.name
     and assigned.batch_number = legacy.batch_number
    where legacy.organization_id = v_branch.organization_id
      and legacy.branch_id is null
      and legacy.quantity > 0
      and assigned.quantity is distinct from 0
  ) then
    raise exception 'HEALTHLIGHT stock repair: duplicate branch batch has nonzero or unknown quantity; review before assigning stock.';
  end if;

  -- Multiple unassigned stocked copies cannot share the branch unique key.
  if exists (
    select 1 from public.drugs
    where organization_id = v_branch.organization_id
      and branch_id is null and quantity > 0
    group by name, batch_number
    having count(*) > 1
  ) then
    raise exception 'HEALTHLIGHT stock repair: multiple unassigned stocked copies exist; review before assigning stock.';
  end if;

  -- Free the branch/name/batch unique key without deleting the empty record,
  -- changing its batch label, or rewriting any sale/claim references.
  update public.drugs assigned
  set branch_id = null,
      updated_at = now()
  where assigned.organization_id = v_branch.organization_id
    and assigned.branch_id = v_branch.id
    and assigned.quantity = 0
    and exists (
      select 1 from public.drugs legacy
      where legacy.organization_id = assigned.organization_id
        and legacy.branch_id is null
        and legacy.quantity > 0
        and legacy.name = assigned.name
        and legacy.batch_number = assigned.batch_number
    );

  get diagnostics v_empty_count = row_count;

  update public.drugs
  set branch_id = v_branch.id,
      updated_at = now()
  where organization_id = v_branch.organization_id
    and branch_id is null
    and quantity > 0;

  get diagnostics v_count = row_count;
  raise notice 'Assigned % existing stocked records to HEALTHLIGHT KORLE-BU.', v_count;
  raise notice 'Preserved % empty duplicate records without a branch assignment.', v_empty_count;
end;
$$;
