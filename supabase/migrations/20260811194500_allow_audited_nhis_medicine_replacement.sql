-- Privileged NHIS claim correction replaces a claim's medicine rows in one
-- transaction. Duration repair history must retain the original medicine UUID
-- without preventing that established correction workflow.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.nhis_duration_repair_audit'::regclass
      and conname = 'nhis_duration_repair_audit_medicine_id_fkey'
      and contype = 'f'
  ) then
    raise exception 'Expected NHIS duration repair medicine foreign key was not found';
  end if;
end;
$$;

alter table public.nhis_duration_repair_audit
  drop constraint nhis_duration_repair_audit_medicine_id_fkey;

comment on column public.nhis_duration_repair_audit.medicine_id is
  'Immutable UUID of the medicine row repaired; retained after privileged claim correction replaces that row.';

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.nhis_duration_repair_audit'::regclass
      and conname = 'nhis_duration_repair_audit_medicine_id_fkey'
  ) then
    raise exception 'NHIS duration repair medicine foreign key removal could not be verified';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'nhis_duration_repair_audit'
      and column_name = 'medicine_id'
      and is_nullable <> 'NO'
  ) then
    raise exception 'NHIS duration repair medicine UUID must remain required';
  end if;
end;
$$;

notify pgrst, 'reload schema';
