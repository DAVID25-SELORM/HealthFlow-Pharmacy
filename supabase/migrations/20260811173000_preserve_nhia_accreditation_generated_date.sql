-- Preserve the accreditation record's original CLAIM-it dateGenerated value.
-- This is credential metadata and must not be replaced with the CXF export date.

alter table if exists public.nhia_configuration
  add column if not exists accreditation_date_generated date;

comment on column public.nhia_configuration.accreditation_date_generated is
  'Original dateGenerated from the NHIA/CLAIM-it accreditation record.';

-- Keep the field intact when offline/local branches synchronize their NHIA
-- configuration. Older branch clients omit it, so updates must preserve the
-- cloud value rather than clearing it.
do $$
declare
  v_function_definition text;
begin
  select pg_get_functiondef(
    'public.branch_sync_upsert_nhia_configuration(text,jsonb)'::regprocedure
  ) into v_function_definition;

  if position('accreditation_expiry_date,' in v_function_definition) = 0
     or position(
       'accreditation_expiry_date = excluded.accreditation_expiry_date,'
       in v_function_definition
     ) = 0 then
    raise exception 'Unexpected branch_sync_upsert_nhia_configuration definition';
  end if;

  v_function_definition := replace(
    v_function_definition,
    'accreditation_expiry_date,',
    'accreditation_expiry_date, accreditation_date_generated,'
  );
  v_function_definition := replace(
    v_function_definition,
    'nullif(p_config->>''accreditation_expiry_date'', '''')::date,',
    'nullif(p_config->>''accreditation_expiry_date'', '''')::date, nullif(coalesce(p_config->>''accreditation_date_generated'', p_config->>''accreditationDateGenerated''), '''')::date,'
  );
  v_function_definition := replace(
    v_function_definition,
    'accreditation_expiry_date = excluded.accreditation_expiry_date,',
    'accreditation_expiry_date = excluded.accreditation_expiry_date, accreditation_date_generated = coalesce(excluded.accreditation_date_generated, nhia_configuration.accreditation_date_generated),'
  );

  execute v_function_definition;
end;
$$;

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
