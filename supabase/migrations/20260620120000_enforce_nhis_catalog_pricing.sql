begin;

create or replace function public.enforce_nhis_claim_medicine_catalog_pricing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_catalog_drug public.nhis_drugs%rowtype;
begin
  select organization_id
  into v_organization_id
  from public.nhis_claims
  where id = new.claim_id;

  if v_organization_id is null then
    raise exception 'NHIS claim organization could not be resolved.';
  end if;

  if new.nhis_drug_id is not null then
    select *
    into v_catalog_drug
    from public.nhis_drugs
    where id = new.nhis_drug_id
      and organization_id = v_organization_id
      and is_active = true;
  end if;

  if v_catalog_drug.id is null and nullif(btrim(new.drug_code), '') is not null then
    select *
    into v_catalog_drug
    from public.nhis_drugs
    where organization_id = v_organization_id
      and upper(btrim(code)) = upper(btrim(new.drug_code))
      and is_active = true
    order by updated_at desc, id
    limit 1;
  end if;

  if v_catalog_drug.id is null then
    raise exception 'Medicine must match an active NHIS catalog item for this organization.';
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

drop trigger if exists resolve_branch_nhis_claim_medicine_drug_reference
  on public.nhis_claim_medicines;
drop trigger if exists enforce_nhis_claim_medicine_catalog_pricing
  on public.nhis_claim_medicines;

create trigger enforce_nhis_claim_medicine_catalog_pricing
before insert or update of
  claim_id,
  nhis_drug_id,
  drug_code,
  description,
  unit,
  unit_price,
  dispensed_qty,
  total_amount
on public.nhis_claim_medicines
for each row
execute function public.enforce_nhis_claim_medicine_catalog_pricing();

create or replace function public.recompute_nhis_claim_total(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.nhis_claims
  set total_amount =
        coalesce((
          select sum(total_amount)
          from public.nhis_claim_medicines
          where claim_id = p_claim_id
        ), 0)
        +
        coalesce((
          select sum(total_amount)
          from public.nhis_claim_services
          where claim_id = p_claim_id
        ), 0),
      updated_at = now()
  where id = p_claim_id;
end;
$$;

create or replace function public.refresh_nhis_claim_total_from_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_nhis_claim_total(old.claim_id);
    return old;
  end if;

  perform public.recompute_nhis_claim_total(new.claim_id);

  if tg_op = 'UPDATE' and new.claim_id is distinct from old.claim_id then
    perform public.recompute_nhis_claim_total(old.claim_id);
  end if;

  return new;
end;
$$;

drop trigger if exists refresh_nhis_claim_total_from_medicine
  on public.nhis_claim_medicines;
create trigger refresh_nhis_claim_total_from_medicine
after insert or update or delete
on public.nhis_claim_medicines
for each row
execute function public.refresh_nhis_claim_total_from_line();

drop trigger if exists refresh_nhis_claim_total_from_service
  on public.nhis_claim_services;
create trigger refresh_nhis_claim_total_from_service
after insert or update or delete
on public.nhis_claim_services
for each row
execute function public.refresh_nhis_claim_total_from_line();

create or replace function public.preserve_server_nhis_claim_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select
    coalesce((
      select sum(total_amount)
      from public.nhis_claim_medicines
      where claim_id = old.id
    ), 0)
    +
    coalesce((
      select sum(total_amount)
      from public.nhis_claim_services
      where claim_id = old.id
    ), 0)
  into new.total_amount;

  return new;
end;
$$;

drop trigger if exists preserve_server_nhis_claim_total
  on public.nhis_claims;
create trigger preserve_server_nhis_claim_total
before update of total_amount
on public.nhis_claims
for each row
execute function public.preserve_server_nhis_claim_total();

revoke all on function public.enforce_nhis_claim_medicine_catalog_pricing() from public;
revoke all on function public.recompute_nhis_claim_total(uuid) from public;
revoke all on function public.refresh_nhis_claim_total_from_line() from public;
revoke all on function public.preserve_server_nhis_claim_total() from public;

commit;
