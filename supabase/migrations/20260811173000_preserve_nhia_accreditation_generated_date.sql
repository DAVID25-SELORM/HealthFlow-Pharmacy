-- Preserve the accreditation record's original CLAIM-it dateGenerated value.
-- This is credential metadata and must not be replaced with the CXF export date.

alter table if exists public.nhia_configuration
  add column if not exists accreditation_date_generated date;

comment on column public.nhia_configuration.accreditation_date_generated is
  'Original dateGenerated from the NHIA/CLAIM-it accreditation record.';

-- Confirmed from WESTPOINT CHEMIST's successful CLAIM-it accreditation record.
update public.nhia_configuration
set accreditation_date_generated = date '2025-12-29'
where credential_code = '03-05-001-02-01954-11-P1-2-011225'
  and accreditation_date_generated is distinct from date '2025-12-29';

do $$
begin
  if exists (
    select 1
    from public.nhia_configuration
    where credential_code = '03-05-001-02-01954-11-P1-2-011225'
      and accreditation_date_generated is distinct from date '2025-12-29'
  ) then
    raise exception 'WESTPOINT accreditation dateGenerated backfill could not be verified';
  end if;
end;
$$;

notify pgrst, 'reload schema';
