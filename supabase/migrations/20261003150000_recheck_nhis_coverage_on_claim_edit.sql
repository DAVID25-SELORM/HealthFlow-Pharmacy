-- Header edits must not move a served supply to an unchecked member/date.
-- AFTER UPDATE makes the new header visible to the existing coverage lookup.
begin;
create or replace function public.guard_nhis_coverage_claim_edit()
returns trigger language plpgsql security definer
set search_path = public, pg_catalog as $$
declare
  medicine record;
  alert record;
begin
  -- Historical branch replication is reconciled separately from signed-in edits.
  if auth.uid() is null then return new; end if;
  if new.member_no is not distinct from old.member_no
     and new.hin is not distinct from old.hin
     and new.service_date_from is not distinct from old.service_date_from
     and new.organization_id is not distinct from old.organization_id then return new; end if;
  if not exists (select 1 from public.nhis_claim_medicines m where m.claim_id=new.id
      and coalesce(m.served_qty,m.dispensed_qty,0)>0
      and coalesce(m.serving_status,'fully_served') not in ('pending','not_available','not_served')) then
    return new;
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.organization_id is distinct from public.user_organization_id() then
    raise exception 'Cannot move a served NHIS claim between organizations.' using errcode='42501';
  end if;
  if not exists (select 1 from public.users u where u.id=auth.uid()
      and u.is_active=true and u.organization_id=new.organization_id) then
    raise exception 'Active organization membership is required.' using errcode='42501';
  end if;
  if nullif(regexp_replace(coalesce(new.member_no,''),'[^A-Za-z0-9]','','g'),'') is null
     and nullif(regexp_replace(coalesce(new.hin,''),'[^A-Za-z0-9]','','g'),'') is null then
    raise exception 'Cannot remove the member number and HIN from a served NHIS claim.' using errcode='23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('nhis-coverage:' ||
    upper(regexp_replace(coalesce(nullif(new.member_no,''),new.hin,''),'[^A-Za-z0-9]','','g')),0));
  for medicine in
    select m.*, d.generic_name, d.strength, d.dosage_form
    from public.nhis_claim_medicines m
    left join lateral (
      select d.generic_name,d.strength,d.dosage_form from public.nhis_drugs d
      where d.organization_id=new.organization_id
        and (d.id=m.nhis_drug_id or upper(trim(d.code))=upper(trim(m.drug_code)))
      order by (d.id=m.nhis_drug_id) desc nulls last,d.id limit 1
    ) d on true
    where m.claim_id=new.id and coalesce(m.served_qty,m.dispensed_qty,0)>0
      and coalesce(m.serving_status,'fully_served') not in ('pending','not_available','not_served')
  loop
    if nullif(btrim(medicine.drug_code),'') is null then
      raise exception 'Cannot check served medicine without a medicine code.' using errcode='23514';
    end if;
    select * into alert from public.check_nhis_active_medication_overlap(
      p_member_no=>new.member_no, p_hin=>new.hin, p_medicine_code=>medicine.drug_code,
      p_service_date=>coalesce(public.nhis_medicine_dispensing_date(medicine.dispensary_date,medicine.served_at,new.service_date_from),current_date),
      p_current_claim_id=>new.id, p_current_organization_id=>new.organization_id,
      p_generic_name=>medicine.generic_name,p_strength=>medicine.strength,p_dosage_form=>medicine.dosage_form,
      p_requested_quantity=>coalesce(medicine.served_qty,medicine.dispensed_qty),
      p_dose=>medicine.dose,p_frequency=>medicine.frequency,p_duration=>medicine.duration) limit 1;
    if found then
      raise exception 'Cannot change this served claim: % overlaps a previous supply with coverage through %. Review the dispensing records.',
        coalesce(medicine.description,medicine.drug_code),alert.coverage_end_date using errcode='23514';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.guard_nhis_coverage_claim_edit() from public,anon,authenticated;
drop trigger if exists guard_nhis_coverage_claim_edit on public.nhis_claims;
create trigger guard_nhis_coverage_claim_edit after update on public.nhis_claims
for each row execute function public.guard_nhis_coverage_claim_edit();
notify pgrst, 'reload schema';
commit;
