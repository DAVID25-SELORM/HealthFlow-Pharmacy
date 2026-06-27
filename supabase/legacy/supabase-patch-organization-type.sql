alter table public.organizations
  add column if not exists organization_type text not null default 'pharmacy';

update public.organizations
set organization_type = 'pharmacy'
where organization_type is null
   or organization_type not in ('pharmacy', 'hospital');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'organizations_organization_type_check'
      and conrelid = 'public.organizations'::regclass
  ) then
    alter table public.organizations
      add constraint organizations_organization_type_check
      check (organization_type in ('pharmacy', 'hospital'));
  end if;
end $$;
