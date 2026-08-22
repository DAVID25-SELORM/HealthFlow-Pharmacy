-- Keep catalogue enforcement strict while returning the affected medicine.
create or replace function public.enforce_nhis_claim_medicine_catalog_pricing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_catalog_drug public.nhis_drugs%rowtype;
  v_label text;
  v_code text;
begin
  select organization_id into v_organization_id
  from public.nhis_claims where id = new.claim_id;

  if v_organization_id is null then
    raise exception 'NHIS claim organization could not be resolved.';
  end if;

  if new.nhis_drug_id is not null then
    select * into v_catalog_drug from public.nhis_drugs
    where id = new.nhis_drug_id and organization_id = v_organization_id and is_active = true;
  end if;

  if v_catalog_drug.id is null and nullif(btrim(new.drug_code), '') is not null then
    select * into v_catalog_drug from public.nhis_drugs
    where organization_id = v_organization_id
      and upper(btrim(code)) = upper(btrim(new.drug_code)) and is_active = true
    order by updated_at desc, id limit 1;
  end if;

  if v_catalog_drug.id is null then
    v_label := coalesce(nullif(btrim(new.description), ''), 'This medicine');
    v_code := nullif(upper(btrim(new.drug_code)), '');
    raise exception '% (%) is not available as an active NHIS catalogue item for this facility.',
      v_label, coalesce(v_code, 'no NHIS code');
  end if;

  if v_catalog_drug.unit_price is null or v_catalog_drug.unit_price < 0 then
    raise exception 'NHIS catalog medicine price must be a valid non-negative amount.';
  end if;
  if coalesce(new.dispensed_qty, 0) < 0 then
    raise exception 'NHIS medicine quantity cannot be negative.';
  end if;

  new.nhis_drug_id := v_catalog_drug.id;
  new.drug_code := v_catalog_drug.code;
  new.description := v_catalog_drug.description;
  new.unit := v_catalog_drug.unit;
  new.unit_price := v_catalog_drug.unit_price;
  new.total_amount := round(v_catalog_drug.unit_price * coalesce(new.dispensed_qty, 0), 2);
  return new;
end;
$$;

revoke all on function public.enforce_nhis_claim_medicine_catalog_pricing() from public;
notify pgrst, 'reload schema';
