-- Fail closed when the online coverage lookup cannot identify the member or medicine.
begin;
create or replace function public.guard_nhis_active_coverage_on_serve()
returns trigger language plpgsql security definer
set search_path = public, pg_catalog as $$
declare
  v_claim public.nhis_claims%rowtype;
  v_drug public.nhis_drugs%rowtype;
  v_alert record;
begin
  -- Branch replication uses its own authenticated completion protocol.
  if auth.uid() is null or coalesce(new.served_qty, 0) <= 0
     or coalesce(new.serving_status, 'pending') not in ('fully_served', 'partially_served') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.served_qty is not distinct from old.served_qty
       and new.serving_status is not distinct from old.serving_status
       and new.drug_code is not distinct from old.drug_code
       and new.dispensary_date is not distinct from old.dispensary_date
       and new.claim_id is not distinct from old.claim_id then
      return new;
    end if;
  end if;

  select * into strict v_claim from public.nhis_claims where id = new.claim_id;
  if v_claim.organization_id is distinct from public.user_organization_id() then
    raise exception 'NHIS claim is outside your organization.' using errcode = '42501';
  end if;

  if nullif(regexp_replace(coalesce(v_claim.member_no, ''), '[^A-Za-z0-9]', '', 'g'), '') is null
     and nullif(regexp_replace(coalesce(v_claim.hin, ''), '[^A-Za-z0-9]', '', 'g'), '') is null then
    raise exception 'Cannot serve: a member number or HIN is required for the online medication coverage check.'
      using errcode = '23514';
  end if;
  if nullif(btrim(new.drug_code), '') is null then
    raise exception 'Cannot serve: a medicine code is required for the online medication coverage check.'
      using errcode = '23514';
  end if;

  if not exists (select 1 from public.users u where u.id = auth.uid()
      and u.is_active = true and u.organization_id = v_claim.organization_id) then
    raise exception 'Active organization membership is required.' using errcode = '42501';
  end if;

  -- Serialize simultaneous dispensing for the same member across claims.
  perform pg_advisory_xact_lock(hashtextextended(
    'nhis-coverage:' || upper(regexp_replace(coalesce(nullif(v_claim.member_no, ''), v_claim.hin, ''), '[^A-Za-z0-9]', '', 'g')), 0
  ));
  select * into v_drug from public.nhis_drugs d
    where d.organization_id = v_claim.organization_id
      and (d.id = new.nhis_drug_id or upper(trim(d.code)) = upper(trim(new.drug_code)))
    order by (d.id = new.nhis_drug_id) desc nulls last, d.id
    limit 1;

  select * into v_alert
  from public.check_nhis_active_medication_overlap(
    p_member_no => v_claim.member_no,
    p_hin => v_claim.hin,
    p_medicine_code => new.drug_code,
    p_service_date => coalesce(new.dispensary_date, v_claim.service_date_from, current_date),
    p_current_claim_id => new.claim_id,
    p_current_organization_id => v_claim.organization_id,
    p_generic_name => v_drug.generic_name,
    p_strength => v_drug.strength,
    p_dosage_form => v_drug.dosage_form,
    p_requested_quantity => new.served_qty,
    p_dose => new.dose,
    p_frequency => new.frequency,
    p_duration => new.duration
  ) limit 1;
  if found then
    raise exception 'Cannot serve %: previously dispensed on %, with coverage through % (% day(s) remaining). Review the previous dispensing before serving.',
      coalesce(new.description, new.drug_code, 'medicine'),
      v_alert.previous_dispensed_date, v_alert.coverage_end_date, v_alert.remaining_days
      using errcode = '23514';
  end if;
  return new;
end $$;

revoke all on function public.guard_nhis_active_coverage_on_serve() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
