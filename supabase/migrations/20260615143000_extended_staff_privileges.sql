alter table public.users
  add column if not exists can_process_sales boolean not null default false,
  add column if not exists can_manage_patients boolean not null default false,
  add column if not exists can_manage_accounting boolean not null default false,
  add column if not exists can_manage_epharmacy boolean not null default false,
  add column if not exists can_view_activity_log boolean not null default false,
  add column if not exists can_adjust_stock boolean not null default false,
  add column if not exists can_approve_purchases boolean not null default false;

update public.users
set can_process_sales = true
where role in ('admin', 'pharmacist', 'assistant', 'cashier', 'technician', 'branch_manager')
  and can_process_sales = false;

update public.users
set can_manage_patients = true
where role in (
  'admin', 'pharmacist', 'assistant', 'technician', 'branch_manager', 'billing',
  'claims_officer', 'nurse', 'doctor', 'records_officer'
)
  and can_manage_patients = false;

update public.users
set can_manage_accounting = true
where role in ('admin', 'accounts_officer')
  and can_manage_accounting = false;

update public.users
set can_manage_epharmacy = true
where role in ('admin', 'pharmacist', 'procurement', 'inventory_officer', 'branch_manager')
  and can_manage_epharmacy = false;

update public.users
set can_view_activity_log = true
where role in ('admin', 'branch_manager', 'super_admin')
  and can_view_activity_log = false;

update public.users
set can_adjust_stock = true
where (
    role in ('admin', 'pharmacist', 'technician', 'procurement', 'inventory_officer', 'branch_manager')
    or can_manage_inventory = true
  )
  and can_adjust_stock = false;

update public.users
set can_approve_purchases = true
where role in ('admin', 'pharmacist', 'branch_manager')
  and can_approve_purchases = false;
