-- Aggregate accounting sales in Postgres so reporting cost grows with the
-- number of payment methods, rather than transferring every sale item to the
-- browser. RLS remains active because this function uses SECURITY INVOKER.

create index if not exists idx_sales_org_completed_date
  on public.sales (organization_id, sale_date)
  where payment_status = 'completed';

create index if not exists idx_sales_org_branch_completed_date
  on public.sales (organization_id, branch_id, sale_date)
  where payment_status = 'completed';

create or replace function public.get_accounting_sales_summary(
  p_start_date date,
  p_end_date date,
  p_branch_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with scoped_sales as (
    select
      s.id,
      s.net_amount,
      s.payment_method
    from public.sales s
    left join public.users seller on seller.id = s.sold_by
    where s.payment_status = 'completed'
      and s.sale_date >= p_start_date::timestamptz
      and s.sale_date < (p_end_date + 1)::timestamptz
      and (
        p_branch_id is null
        or s.branch_id = p_branch_id
        or (s.branch_id is null and seller.branch_id = p_branch_id)
      )
  ),
  sales_totals as (
    select
      coalesce(sum(net_amount), 0)::numeric as revenue,
      count(*)::bigint as sale_count
    from scoped_sales
  ),
  cost_totals as (
    select coalesce(
      sum(
        coalesce(
          si.line_cost,
          si.unit_cost_at_sale * si.quantity,
          d.cost_price * si.quantity,
          0
        )
      ),
      0
    )::numeric as cogs
    from scoped_sales s
    join public.sale_items si on si.sale_id = s.id
    left join public.drugs d on d.id = si.drug_id
  ),
  payment_totals as (
    select coalesce(
      jsonb_object_agg(payment_method, amount),
      '{}'::jsonb
    ) as by_method
    from (
      select
        coalesce(nullif(payment_method, ''), 'unknown') as payment_method,
        sum(net_amount)::numeric as amount
      from scoped_sales
      group by coalesce(nullif(payment_method, ''), 'unknown')
    ) grouped_payments
  )
  select jsonb_build_object(
    'revenue', sales_totals.revenue,
    'cogs', cost_totals.cogs,
    'count', sales_totals.sale_count,
    'byMethod', payment_totals.by_method
  )
  from sales_totals
  cross join cost_totals
  cross join payment_totals;
$$;

revoke all on function public.get_accounting_sales_summary(date, date, uuid) from public;
grant execute on function public.get_accounting_sales_summary(date, date, uuid) to authenticated;

comment on function public.get_accounting_sales_summary(date, date, uuid) is
  'Returns an RLS-scoped sales and COGS summary without transferring sale rows to the client.';
