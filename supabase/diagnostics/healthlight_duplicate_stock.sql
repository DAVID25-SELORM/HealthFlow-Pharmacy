-- Read-only: show the exact duplicate pairs blocking the stock repair.
-- Return full inventory rows so quantities, status, expiry and catalogue
-- metadata can be compared before choosing how to resolve each conflict.
select
  legacy.name,
  legacy.batch_number,
  legacy.quantity as unassigned_quantity,
  assigned.quantity as branch_quantity,
  to_jsonb(legacy) as unassigned_record,
  to_jsonb(assigned) as branch_record
from public.branches b
join public.drugs legacy
  on legacy.organization_id = b.organization_id
 and legacy.branch_id is null
 and legacy.quantity > 0
join public.drugs assigned
  on assigned.organization_id = b.organization_id
 and assigned.branch_id = b.id
 and assigned.name = legacy.name
 and assigned.batch_number = legacy.batch_number
where b.id = 'f0907191-dcb9-4958-b377-c03abb3e2891'::uuid
order by legacy.name, legacy.batch_number, legacy.id, assigned.id;
