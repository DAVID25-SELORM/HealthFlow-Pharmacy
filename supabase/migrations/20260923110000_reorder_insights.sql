-- Reorder Centre phase 3: sales velocity and price history, aggregated server-side so the
-- browser never downloads sales or purchase history. Read-only; changes no data.
--
-- Usage comes only from completed sales lines (sale_items). It does not include NHIS
-- dispensing (which is not a sale), and it invents nothing: a medicine with too little
-- history is reported as such by the app, not given an estimate.
begin;

create or replace function public.get_reorder_insights(
  p_drug_ids uuid[] default null,
  p_window_days integer default 90
)
returns table (
  drug_id uuid,
  units_sold numeric,
  history_days integer,
  last_cost numeric,
  previous_cost numeric,
  last_supplier text,
  last_purchase_date date
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_org uuid := public.user_organization_id();
  v_window integer := greatest(1, least(coalesce(p_window_days, 90), 365));
begin
  if not public.user_can_manage_purchases() then
    raise exception 'You do not have permission to view reorder insights.' using errcode = '42501';
  end if;

  return query
  with target as (
    select d.id, d.created_at
    from public.drugs d
    where d.organization_id = v_org
      and (p_drug_ids is null or d.id = any(p_drug_ids))
  ),
  sold as (
    select si.drug_id, sum(si.quantity) as units
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.organization_id = v_org
      and s.payment_status = 'completed'
      and s.sale_date::timestamptz >= now() - make_interval(days => v_window)
      and si.drug_id in (select t.id from target t)
    group by si.drug_id
  ),
  -- One cost per placed/received purchase, newest first. The cost actually paid on the latest
  -- receipt wins over the cost written on the order.
  costs as (
    select
      pi.drug_id,
      p.supplier_name,
      coalesce(p.ordered_at::date, p.purchase_date) as bought_on,
      coalesce(
        (select r.unit_cost from public.purchase_receipts r
          where r.purchase_item_id = pi.id order by r.received_at desc limit 1),
        pi.unit_cost
      ) as cost,
      row_number() over (
        partition by pi.drug_id
        order by coalesce(p.ordered_at, p.purchase_date::timestamptz) desc, p.created_at desc
      ) as rn
    from public.purchase_items pi
    join public.purchases p on p.id = pi.purchase_id
    where p.organization_id = v_org
      and p.status in ('ordered', 'partially_received', 'completed')
      and pi.unit_cost > 0
      and pi.drug_id in (select t.id from target t)
  )
  select
    t.id,
    coalesce(so.units, 0),
    greatest(0, least(v_window, (current_date - t.created_at::date)))::integer,
    c1.cost,
    c2.cost,
    c1.supplier_name,
    c1.bought_on
  from target t
  left join sold so on so.drug_id = t.id
  left join costs c1 on c1.drug_id = t.id and c1.rn = 1
  left join costs c2 on c2.drug_id = t.id and c2.rn = 2;
end;
$$;

revoke all on function public.get_reorder_insights(uuid[], integer) from public, anon;
grant execute on function public.get_reorder_insights(uuid[], integer) to authenticated;

notify pgrst, 'reload schema';

commit;
