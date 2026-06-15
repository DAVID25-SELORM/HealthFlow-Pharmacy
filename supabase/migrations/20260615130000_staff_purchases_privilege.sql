begin;

alter table public.users
  add column if not exists can_manage_purchases boolean not null default false;

update public.users
set can_manage_purchases = true
where role in ('admin', 'pharmacist', 'procurement', 'inventory_officer', 'branch_manager')
  and can_manage_purchases = false;

alter table public.users
  drop constraint if exists users_role_check;

alter table public.users
  add constraint users_role_check
  check (role in (
    'admin',
    'pharmacist',
    'technician',
    'assistant',
    'cashier',
    'inventory_officer',
    'claims_officer',
    'accounts_officer',
    'nurse',
    'doctor',
    'records_officer',
    'other',
    'branch_manager',
    'procurement',
    'billing',
    'delivery',
    'super_admin'
  ));

commit;
