-- BRANCH-003: a branch asks another branch (normally the main store) for stock; the sender approves or declines.
--
-- A member of staff who belongs to a branch can only send stock from that branch (BRANCH-002 also stops them
-- reading the main store's stock), so a branch manager cannot pull stock from the main store by themselves.
-- This adds the missing step:
--   1. Inventory staff at a branch pick medicines held by another branch and ask for quantities.
--   2. An administrator, or staff of the sending branch (or staff with no branch), approves - lowering or dropping
--      lines if they cannot supply them all - or declines with a reason. The requester can cancel while it is pending.
--   3. Approving dispatches an ordinary confirmed transfer through create_branch_stock_transfer(), so every stock check
--      (active product, not expired, enough stock, one confirmation by the receiving branch, short quantities returned)
--      and every stock movement is exactly the existing transfer flow. A request itself never moves stock.
--
-- Additive: two tables, one sequence, five functions. No existing table, policy or function is changed.
-- Needs the confirmed branch transfer migration (20261111090000) and the branch scope migration (20261116090000).
-- Undo with 03-rollback.sql.
begin;

do $$
begin
  if to_regprocedure('public.create_branch_stock_transfer(uuid,uuid,jsonb,text)') is null then
    raise exception 'Apply the confirmed branch stock transfer migration (20261111090000) first.';
  end if;
  if to_regprocedure('public.user_branch_scope()') is null then
    raise exception 'Apply the branch scope migration (20261116090000) first.';
  end if;
end $$;

create sequence if not exists public.branch_stock_request_number_seq;
revoke all on sequence public.branch_stock_request_number_seq from public, anon, authenticated;

create table if not exists public.branch_stock_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_number text not null,
  requesting_branch_id uuid not null references public.branches(id),
  source_branch_id uuid not null references public.branches(id),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'cancelled')),
  notes text check (notes is null or length(notes) <= 500),
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.users(id),
  resolved_at timestamptz,
  resolution_notes text check (resolution_notes is null or length(resolution_notes) <= 500),
  transfer_id uuid references public.branch_stock_transfers(id) on delete set null,
  unique (organization_id, request_number),
  check (requesting_branch_id <> source_branch_id),
  check ((status = 'pending') = (resolved_at is null))
);

create table if not exists public.branch_stock_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.branch_stock_requests(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_drug_id uuid not null references public.drugs(id),
  medicine_name text not null,
  batch_number text,
  expiry_date date,
  unit text,
  quantity_requested numeric(10, 2) not null check (quantity_requested > 0),
  quantity_approved numeric(10, 2) check (quantity_approved >= 0 and quantity_approved <= quantity_requested),
  unique (request_id, source_drug_id)
);

create index if not exists branch_stock_requests_org_status
  on public.branch_stock_requests (organization_id, status, created_at desc);
create index if not exists branch_stock_requests_org_requesting
  on public.branch_stock_requests (organization_id, requesting_branch_id);
create index if not exists branch_stock_requests_org_source
  on public.branch_stock_requests (organization_id, source_branch_id);
create index if not exists branch_stock_request_items_request
  on public.branch_stock_request_items (request_id);
create index if not exists branch_stock_request_items_source_drug
  on public.branch_stock_request_items (source_drug_id);

alter table public.branch_stock_requests enable row level security;
alter table public.branch_stock_request_items enable row level security;
revoke all on public.branch_stock_requests from public, anon, authenticated;
revoke all on public.branch_stock_request_items from public, anon, authenticated;
grant select on public.branch_stock_requests to authenticated;
grant select on public.branch_stock_request_items to authenticated;
grant all on public.branch_stock_requests to service_role;
grant all on public.branch_stock_request_items to service_role;

-- Members of the pharmacy can read its requests; all writes go through the functions below.
drop policy if exists branch_stock_requests_select_org on public.branch_stock_requests;
create policy branch_stock_requests_select_org on public.branch_stock_requests
  for select to authenticated
  using (organization_id = public.user_organization_id());

drop policy if exists branch_stock_request_items_select_org on public.branch_stock_request_items;
create policy branch_stock_request_items_select_org on public.branch_stock_request_items
  for select to authenticated
  using (organization_id = public.user_organization_id());

-- Branch staff (BRANCH-002) see only requests that involve their branch, on either side.
drop policy if exists branch_stock_requests_branch_scope on public.branch_stock_requests;
create policy branch_stock_requests_branch_scope on public.branch_stock_requests
  as restrictive for select to authenticated
  using (
    (select public.user_branch_scope()) is null
    or requesting_branch_id = (select public.user_branch_scope())
    or source_branch_id = (select public.user_branch_scope())
  );

drop policy if exists branch_stock_request_items_branch_scope on public.branch_stock_request_items;
create policy branch_stock_request_items_branch_scope on public.branch_stock_request_items
  as restrictive for select to authenticated
  using (
    (select public.user_branch_scope()) is null
    or exists (select 1 from public.branch_stock_requests q where q.id = branch_stock_request_items.request_id)
  );

-- ---------------------------------------------------------------------------
-- 1. What can I ask this branch for?  (stock levels only: no prices, no costs)
--    Branch staff cannot read another branch's stock directly (BRANCH-002), so this narrow function answers.
-- ---------------------------------------------------------------------------
create or replace function public.search_branch_stock_for_request(
  p_source_branch_id uuid, p_term text, p_limit integer default 12
) returns table (
  id uuid, name text, batch_number text, expiry_date date, unit text, quantity numeric
)
language plpgsql stable security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  v_term text := btrim(coalesce(p_term, ''));
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null or not a.can_send then
    raise exception 'Only inventory staff can request stock.';
  end if;
  if length(v_term) < 2 then
    return;
  end if;
  if not exists (select 1 from public.branches b
                  where b.id = p_source_branch_id and b.organization_id = a.organization_id and b.is_active is true) then
    raise exception 'The branch could not be found.';
  end if;
  return query
    select d.id, d.name::text, d.batch_number::text, d.expiry_date, d.unit::text, d.quantity
    from public.drugs d
    where d.organization_id = a.organization_id
      and d.branch_id = p_source_branch_id
      and d.status = 'active'
      and coalesce(d.quantity, 0) > 0
      and (d.expiry_date is null or d.expiry_date >= current_date)
      and d.name ilike '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    order by d.name, d.expiry_date nulls last
    limit least(greatest(coalesce(p_limit, 12), 1), 25);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Ask
-- ---------------------------------------------------------------------------
create or replace function public.create_branch_stock_request(
  p_source_branch_id uuid, p_requesting_branch_id uuid, p_items jsonb, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  v_src public.branches%rowtype;
  v_req public.branches%rowtype;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_wanted integer;
  v_count integer;
  v_request uuid;
  v_number text;
  r record;
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null or not a.can_send then
    raise exception 'Only inventory staff can request stock.';
  end if;
  if v_notes is not null and length(v_notes) > 500 then
    raise exception 'Notes can be at most 500 characters.';
  end if;
  if p_source_branch_id is null or p_requesting_branch_id is null or p_source_branch_id = p_requesting_branch_id then
    raise exception 'Choose two different branches.';
  end if;

  select * into v_src from public.branches
   where id = p_source_branch_id and organization_id = a.organization_id and is_active is true;
  if not found then raise exception 'The branch you are asking could not be found.'; end if;
  select * into v_req from public.branches
   where id = p_requesting_branch_id and organization_id = a.organization_id and is_active is true;
  if not found then raise exception 'The receiving branch could not be found.'; end if;

  -- Staff tied to one branch can only ask on behalf of that branch; administrators and org-level staff for any.
  if not a.is_admin and a.user_branch_id is not null and a.user_branch_id <> p_requesting_branch_id then
    raise exception 'You can only request stock for your own branch.';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'Add between 1 and 100 medicines to the request.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where jsonb_typeof(e) <> 'object'
       or not (coalesce(e ->> 'drug_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       or not (coalesce(e ->> 'quantity', '') ~ '^[0-9]{1,8}(\.[0-9]{1,2})?$')
       or (case when coalesce(e ->> 'quantity', '') ~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
                then (e ->> 'quantity')::numeric <= 0 else true end)
  ) then
    raise exception 'Every line needs a medicine and a quantity above zero (up to 2 decimals).';
  end if;

  select count(distinct (e ->> 'drug_id')::uuid) into v_wanted from jsonb_array_elements(p_items) e;

  v_number := 'REQ-' || lpad(nextval('public.branch_stock_request_number_seq')::text, 6, '0');
  insert into public.branch_stock_requests
    (organization_id, request_number, requesting_branch_id, source_branch_id, notes, created_by)
  values (a.organization_id, v_number, p_requesting_branch_id, p_source_branch_id, v_notes, a.user_id)
  returning id into v_request;

  v_count := 0;
  for r in
    select d.id, d.name, d.batch_number, d.expiry_date, d.unit, d.status, d.branch_id, q.qty
    from (
      select (e ->> 'drug_id')::uuid as drug_id, sum((e ->> 'quantity')::numeric) as qty
      from jsonb_array_elements(p_items) e group by 1
    ) q
    join public.drugs d on d.id = q.drug_id and d.organization_id = a.organization_id
    order by d.id
  loop
    if r.branch_id is distinct from p_source_branch_id then
      raise exception '% is not stocked at %.', r.name, v_src.name;
    end if;
    if r.status is distinct from 'active' then
      raise exception '% is not an active product.', r.name;
    end if;
    if r.expiry_date is not null and r.expiry_date < current_date then
      raise exception '% (batch %) is expired and cannot be requested.', r.name, coalesce(r.batch_number, '-');
    end if;
    if r.qty > 99999999.99 then
      raise exception 'The quantity of % is too large.', r.name;
    end if;
    insert into public.branch_stock_request_items
      (request_id, organization_id, source_drug_id, medicine_name, batch_number, expiry_date, unit, quantity_requested)
    values (v_request, a.organization_id, r.id, r.name, r.batch_number, r.expiry_date, r.unit, r.qty);
    v_count := v_count + 1;
  end loop;

  if v_count <> v_wanted then
    raise exception 'One or more medicines could not be found.';
  end if;

  begin
    perform public.log_audit_event('stock_request', 'branch_stock_requests', v_request, 'requested',
      jsonb_build_object('request_number', v_number, 'requesting_branch', v_req.name,
                         'source_branch', v_src.name, 'lines', v_count), a.organization_id);
  exception when others then
    null; -- the request rows are the record
  end;

  return jsonb_build_object('request_id', v_request, 'request_number', v_number, 'status', 'pending', 'lines', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Approve (dispatches the transfer) / decline / cancel
--    Who may approve or decline is exactly who may send from the asked branch: an administrator, staff of that
--    branch, or staff with no branch.
-- ---------------------------------------------------------------------------
create or replace function public.approve_branch_stock_request(
  p_request_id uuid, p_items jsonb default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  q public.branch_stock_requests%rowtype;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_listed integer;
  v_lines integer;
  v_send jsonb := '[]'::jsonb;
  v_transfer jsonb;
  v_note text;
  i record;
  v_qty numeric;
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null or not a.can_send then
    raise exception 'Only inventory staff can approve a stock request.';
  end if;
  if v_notes is not null and length(v_notes) > 500 then
    raise exception 'Notes can be at most 500 characters.';
  end if;

  select * into q from public.branch_stock_requests
   where id = p_request_id and organization_id = a.organization_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if q.status <> 'pending' then raise exception 'This request is already %.', q.status; end if;
  if not a.is_admin and a.user_branch_id is not null and a.user_branch_id <> q.source_branch_id then
    raise exception 'Only an administrator or staff of the branch being asked can approve this request.';
  end if;

  select count(*) into v_lines from public.branch_stock_request_items where request_id = q.id;

  if p_items is not null then
    if jsonb_typeof(p_items) <> 'array' then raise exception 'Confirm the quantity of every line.'; end if;
    if exists (
      select 1 from jsonb_array_elements(p_items) e
      where jsonb_typeof(e) <> 'object'
         or not (coalesce(e ->> 'item_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
         or not (coalesce(e ->> 'quantity_approved', '') ~ '^[0-9]{1,8}(\.[0-9]{1,2})?$')
    ) then
      raise exception 'Every line needs an approved quantity of zero or more (up to 2 decimals).';
    end if;
    select count(distinct (e ->> 'item_id')::uuid) into v_listed from jsonb_array_elements(p_items) e;
    if v_listed <> v_lines
       or jsonb_array_length(p_items) <> v_lines
       or exists (
         select 1 from jsonb_array_elements(p_items) e
         where not exists (select 1 from public.branch_stock_request_items ri
                            where ri.request_id = q.id and ri.id = (e ->> 'item_id')::uuid)
       ) then
      raise exception 'The approved lines do not match this request.';
    end if;
  end if;

  for i in
    select ri.id, ri.source_drug_id, ri.medicine_name, ri.quantity_requested,
           case when p_items is null then ri.quantity_requested
                else (select (e ->> 'quantity_approved')::numeric
                        from jsonb_array_elements(p_items) e where (e ->> 'item_id')::uuid = ri.id)
           end as qty
    from public.branch_stock_request_items ri
    where ri.request_id = q.id
    order by ri.source_drug_id
  loop
    v_qty := i.qty;
    if v_qty > i.quantity_requested then
      raise exception 'Approved quantity for % cannot be more than the % requested.', i.medicine_name, i.quantity_requested;
    end if;
    update public.branch_stock_request_items set quantity_approved = v_qty where id = i.id;
    if v_qty > 0 then
      v_send := v_send || jsonb_build_array(jsonb_build_object('drug_id', i.source_drug_id, 'quantity', v_qty::text));
    end if;
  end loop;

  if jsonb_array_length(v_send) = 0 then
    raise exception 'Nothing approved. Use Decline to turn the whole request down.';
  end if;

  v_note := left('Request ' || q.request_number || coalesce(': ' || v_notes, ''), 500);
  -- Same checks and stock movements as any transfer. If stock is short this raises and the approval rolls back.
  v_transfer := public.create_branch_stock_transfer(q.source_branch_id, q.requesting_branch_id, v_send, v_note);

  update public.branch_stock_requests
     set status = 'approved', resolved_by = a.user_id, resolved_at = now(),
         resolution_notes = v_notes, transfer_id = (v_transfer ->> 'transfer_id')::uuid
   where id = q.id;

  begin
    perform public.log_audit_event('stock_request', 'branch_stock_requests', q.id, 'approved',
      jsonb_build_object('request_number', q.request_number, 'transfer_number', v_transfer ->> 'transfer_number',
                         'lines', jsonb_array_length(v_send)), q.organization_id);
  exception when others then
    null;
  end;

  return jsonb_build_object('request_id', q.id, 'request_number', q.request_number, 'status', 'approved',
                            'transfer_id', v_transfer ->> 'transfer_id', 'transfer_number', v_transfer ->> 'transfer_number');
end;
$$;

create or replace function public.decline_branch_stock_request(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  q public.branch_stock_requests%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null or not a.can_send then
    raise exception 'Only inventory staff can decline a stock request.';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then
    raise exception 'Enter a reason of 5 to 500 characters.';
  end if;
  select * into q from public.branch_stock_requests
   where id = p_request_id and organization_id = a.organization_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if q.status <> 'pending' then raise exception 'This request is already %.', q.status; end if;
  if not a.is_admin and a.user_branch_id is not null and a.user_branch_id <> q.source_branch_id then
    raise exception 'Only an administrator or staff of the branch being asked can decline this request.';
  end if;

  update public.branch_stock_requests
     set status = 'declined', resolved_by = a.user_id, resolved_at = now(), resolution_notes = v_reason
   where id = q.id;
  begin
    perform public.log_audit_event('stock_request', 'branch_stock_requests', q.id, 'declined',
      jsonb_build_object('request_number', q.request_number, 'reason', v_reason), q.organization_id);
  exception when others then
    null;
  end;
  return jsonb_build_object('request_id', q.id, 'request_number', q.request_number, 'status', 'declined');
end;
$$;

create or replace function public.cancel_branch_stock_request(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  q public.branch_stock_requests%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null then raise exception 'You must be signed in to cancel a request.'; end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then
    raise exception 'Enter a reason of 5 to 500 characters.';
  end if;
  select * into q from public.branch_stock_requests
   where id = p_request_id and organization_id = a.organization_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if q.status <> 'pending' then raise exception 'This request is already %.', q.status; end if;
  if not (q.created_by = a.user_id or a.is_admin
          or (a.is_manager and (a.user_branch_id is null or a.user_branch_id = q.requesting_branch_id))) then
    raise exception 'Only the person who asked, an administrator or the manager of the asking branch can cancel this request.';
  end if;

  update public.branch_stock_requests
     set status = 'cancelled', resolved_by = a.user_id, resolved_at = now(), resolution_notes = v_reason
   where id = q.id;
  begin
    perform public.log_audit_event('stock_request', 'branch_stock_requests', q.id, 'cancelled',
      jsonb_build_object('request_number', q.request_number, 'reason', v_reason), q.organization_id);
  exception when others then
    null;
  end;
  return jsonb_build_object('request_id', q.id, 'request_number', q.request_number, 'status', 'cancelled');
end;
$$;

revoke all on function public.search_branch_stock_for_request(uuid, text, integer) from public, anon;
revoke all on function public.create_branch_stock_request(uuid, uuid, jsonb, text) from public, anon;
revoke all on function public.approve_branch_stock_request(uuid, jsonb, text) from public, anon;
revoke all on function public.decline_branch_stock_request(uuid, text) from public, anon;
revoke all on function public.cancel_branch_stock_request(uuid, text) from public, anon;
grant execute on function public.search_branch_stock_for_request(uuid, text, integer) to authenticated;
grant execute on function public.create_branch_stock_request(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.approve_branch_stock_request(uuid, jsonb, text) to authenticated;
grant execute on function public.decline_branch_stock_request(uuid, text) to authenticated;
grant execute on function public.cancel_branch_stock_request(uuid, text) to authenticated;

notify pgrst, 'reload schema';
commit;
