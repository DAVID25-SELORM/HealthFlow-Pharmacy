-- Read-only diagnosis for HEALTH LIGHT LTD's KORLE-BU sales session.
-- Branch ID verified from the live shift.opened activity record.
-- Run in the project's Supabase SQL Editor. No stock is changed.

-- Locate every Enoxaparin record in this organization, including unassigned
-- and inactive records that the branch POS cannot return.
with target as (
  select id, organization_id
  from public.branches
  where id = 'f0907191-dcb9-4958-b377-c03abb3e2891'::uuid
)
select d.id, d.name, d.batch_number, d.quantity, d.status,
       d.branch_id, b.name as branch_name, b.is_active as branch_is_active,
       d.expiry_date, d.updated_at,
       case
         when d.status is distinct from 'active' then 'Inactive status'
         when d.branch_id is null then 'No branch assigned'
         when d.branch_id <> t.id then 'Assigned to another branch'
         when coalesce(d.quantity, 0) <= 0 then 'No positive stock'
         else 'Matches branch POS stock filters'
       end as pos_visibility
from target t
join public.drugs d on d.organization_id = t.organization_id
left join public.branches b on b.id = d.branch_id
where d.name ilike '%enox%' or d.batch_number ilike '%ENO%'
order by d.name, d.branch_id nulls first, d.batch_number;

-- Show where this organization's positive stock is held.
with target as (
  select organization_id
  from public.branches
  where id = 'f0907191-dcb9-4958-b377-c03abb3e2891'::uuid
)
select d.branch_id, b.name as branch_name, d.status,
       count(*) as stocked_records, sum(d.quantity) as units
from target t
join public.drugs d on d.organization_id = t.organization_id
left join public.branches b on b.id = d.branch_id
where d.quantity > 0
group by d.branch_id, b.name, d.status
order by b.name nulls first, d.status;
