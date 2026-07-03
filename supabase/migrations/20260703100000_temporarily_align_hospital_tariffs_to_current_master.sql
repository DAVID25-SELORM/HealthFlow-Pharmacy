-- Until NHIA supplies the remaining current facility-specific schedules, use
-- the verified 617-row FEB 2023 Private Primary Care Hospital exclusive
-- schedule as the temporary price master for every existing active hospital
-- tariff set. This changes prices only: facility labels, catering labels,
-- clinical scope, age bands, and provider-level controls remain intact.
--
-- Do not update saved claim-service snapshots here. Historical claims must
-- retain the amount accepted at the time they were prepared or submitted.

begin;

do $$
declare
  source_count integer;
  target_count integer;
  updated_count integer;
begin
  select count(distinct gdrg_code)
  into source_count
  from public.nhia_tariff_items
  where tariff_version = 'FEB 2023'
    and facility_group = 'Private Primary Care Hospital'
    and catering_option = 'exclusive'
    and source_file = 'Private Primary Care Hospital (Catering Exclusive) Tariff JAN 2023 (1).pdf'
    and is_active = true;

  if source_count <> 617 then
    raise exception
      'Expected 617 verified FEB 2023 master tariff codes, found %. Migration stopped without changing prices.',
      source_count;
  end if;

  select count(*)
  into target_count
  from public.nhia_tariff_items target
  where target.tariff_version = 'FEB 2023'
    and target.is_active = true
    and exists (
      select 1
      from public.nhia_tariff_items source
      where source.tariff_version = 'FEB 2023'
        and source.facility_group = 'Private Primary Care Hospital'
        and source.catering_option = 'exclusive'
        and source.source_file = 'Private Primary Care Hospital (Catering Exclusive) Tariff JAN 2023 (1).pdf'
        and source.is_active = true
        and source.gdrg_code = target.gdrg_code
    );

  update public.nhia_tariff_items target
  set
    tariff_amount = source.tariff_amount,
    updated_at = now()
  from public.nhia_tariff_items source
  where source.tariff_version = 'FEB 2023'
    and source.facility_group = 'Private Primary Care Hospital'
    and source.catering_option = 'exclusive'
    and source.source_file = 'Private Primary Care Hospital (Catering Exclusive) Tariff JAN 2023 (1).pdf'
    and source.is_active = true
    and target.tariff_version = source.tariff_version
    and target.gdrg_code = source.gdrg_code
    and target.is_active = true
    and target.tariff_amount is distinct from source.tariff_amount;

  get diagnostics updated_count = row_count;

  raise notice
    'Verified % master codes; % active hospital tariff rows covered; % prices aligned.',
    source_count,
    target_count,
    updated_count;
end $$;

commit;
