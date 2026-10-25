-- A service/branch write must not create a new supply without the authenticated
-- cloud coverage check. Preserve unchanged historical rows and pending drafts.
begin;
-- Restore the complete deployed identity, date and locking checks after the earlier replacement.
CREATE OR REPLACE FUNCTION public.guard_nhis_active_coverage_on_serve()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
       and new.served_at is not distinct from old.served_at
       and new.nhis_drug_id is not distinct from old.nhis_drug_id
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
  perform public.lock_nhis_coverage_identifiers(v_claim.member_no,v_claim.hin);
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
    p_service_date => coalesce(public.nhis_medicine_dispensing_date(new.dispensary_date, new.served_at, v_claim.service_date_from), current_date),
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
end $function$
;
create or replace function public.require_authenticated_nhis_supply()
returns trigger language plpgsql security definer
set search_path=public,pg_catalog as $$
begin
  if auth.uid() is not null then return new; end if;
  if tg_op='UPDATE' then
    if greatest(coalesce(old.served_qty,0),coalesce(old.dispensed_qty,0))>0
      or old.serving_status in ('fully_served','partially_served') then
      if (to_jsonb(new) - array['updated_at','description','unit_price','total_amount'])
         is distinct from (to_jsonb(old) - array['updated_at','description','unit_price','total_amount']) then
        raise exception 'Changing supplied NHIS history requires an authenticated online medication coverage check.' using errcode='23514';
      end if;
    end if;
  end if;
  if greatest(coalesce(new.served_qty,0),coalesce(new.dispensed_qty,0)) <= 0
     and coalesce(new.serving_status,'pending') not in ('fully_served','partially_served') then
    return new;
  end if;
  if tg_op='UPDATE' then
    if (to_jsonb(new) - array['updated_at','description','unit_price','total_amount'])
       is not distinct from
       (to_jsonb(old) - array['updated_at','description','unit_price','total_amount']) then
      return new;
    end if;
  end if;
  raise exception 'NHIS serving requires an authenticated online medication coverage check. Save a pending claim and serve it in the cloud workspace.'
    using errcode='23514';
end $$;
revoke all on function public.require_authenticated_nhis_supply() from public,anon,authenticated;
drop trigger if exists require_authenticated_nhis_supply on public.nhis_claim_medicines;
create trigger require_authenticated_nhis_supply before insert or update on public.nhis_claim_medicines
for each row execute function public.require_authenticated_nhis_supply();
-- A branch may acknowledge an exact cloud snapshot without deleting/reinserting
-- its supplied lines. Changed history requires the authenticated cloud workflow.
create or replace function public.nhis_branch_history_replay(p_sync_token text,p_id uuid,p_record jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare client record; saved public.nhis_claims%rowtype; incoming public.nhis_claims%rowtype;
  saved_lines jsonb; incoming_lines jsonb; saved_services jsonb; incoming_services jsonb;
begin
  client := public.get_branch_sync_client(p_sync_token);
  select * into saved from public.nhis_claims where id=p_id for update;
  if not found then return null; end if;
  if saved.organization_id is distinct from client.organization_id
     or (saved.branch_id is not null and saved.branch_id is distinct from client.branch_id) then
    raise exception 'Branch NHIS claim is outside your scope.' using errcode='42501';
  end if;
  if not exists(select 1 from public.nhis_claim_medicines where claim_id=p_id
    and (greatest(coalesce(served_qty,0),coalesce(dispensed_qty,0))>0
      or serving_status in ('fully_served','partially_served'))) then return null; end if;
  incoming := jsonb_populate_record(null::public.nhis_claims,p_record);
  -- Do not acknowledge a replay while silently discarding changed service lines.
  if to_regclass('public.nhis_claim_services') is not null then
    execute 'select coalesce(jsonb_agg(to_jsonb(s)-array[''created_at'',''updated_at''] order by s.id),''[]''::jsonb) from public.nhis_claim_services s where claim_id=$1'
      into saved_services using p_id;
    execute 'select coalesce(jsonb_agg(to_jsonb(s)-array[''created_at'',''updated_at''] order by s.id),''[]''::jsonb) from jsonb_populate_recordset(null::public.nhis_claim_services,$1) s'
      into incoming_services using coalesce(p_record->'nhis_claim_services','[]'::jsonb);
  else
    saved_services := '[]'::jsonb;
    incoming_services := coalesce(p_record->'nhis_claim_services','[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m)-array['created_at','updated_at'] order by m.id),'[]'::jsonb)
    into saved_lines from public.nhis_claim_medicines m where claim_id=p_id;
  select coalesce(jsonb_agg(to_jsonb(m)-array['created_at','updated_at'] order by m.id),'[]'::jsonb)
    into incoming_lines from jsonb_populate_recordset(null::public.nhis_claim_medicines,
      coalesce(p_record->'nhis_claim_medicines','[]'::jsonb)) m;
  if (to_jsonb(saved)-array['created_at','updated_at']) is distinct from
     (to_jsonb(incoming)-array['created_at','updated_at']) or saved_lines is distinct from incoming_lines
     or saved_services is distinct from incoming_services then
    raise exception 'Supplied NHIS history differs from the cloud record. Refresh the branch snapshot and correct the claim in the cloud workspace.' using errcode='23514';
  end if;
  return jsonb_build_object('entity_type','nhis_claims','local_id',p_id,'remote_id',p_id,
    'organization_id',client.organization_id,'branch_id',client.branch_id,'reused',true);
end $$;
revoke all on function public.nhis_branch_history_replay(text,uuid,jsonb) from public,anon,authenticated;
create or replace function public.nhis_branch_pending_payload(p_record jsonb)
returns jsonb language plpgsql immutable set search_path=public,pg_catalog as $$
declare item jsonb; items jsonb := '[]'::jsonb;
begin
  if coalesce(nullif(p_record->>'status',''),'draft') not in ('draft','pending_serving','serving_in_progress')
    or nullif(p_record->>'direct_served_at','') is not null then
    raise exception 'New branch NHIS claims must remain pending until cloud serving.' using errcode='23514';
  end if;
  for item in select value from jsonb_array_elements(coalesce(p_record->'nhis_claim_medicines','[]'::jsonb)) loop
    if greatest(coalesce(nullif(item->>'served_qty','')::numeric,0),coalesce(nullif(item->>'dispensed_qty','')::numeric,0))>0
      or coalesce(item->>'serving_status','pending') in ('fully_served','partially_served') then
      raise exception 'New branch NHIS supply requires cloud serving.' using errcode='23514';
    end if;
    items := items || jsonb_build_array(item || jsonb_build_object('served_qty',0,'dispensed_qty',0,'serving_status','pending'));
  end loop;
  return p_record || jsonb_build_object('status',coalesce(nullif(p_record->>'status',''),'draft'),'nhis_claim_medicines',items);
end $$;
revoke all on function public.nhis_branch_pending_payload(jsonb) from public,anon,authenticated;
do $patch$
declare definition text; anchor text := 'v_response := public.branch_sync_upsert_offline_record_core(';
begin
  select pg_get_functiondef('public.branch_sync_upsert_nhis_claim_with_serving_metadata(text,uuid,jsonb)'::regprocedure) into definition;
  if position('public.nhis_branch_history_replay(' in definition)=0 then
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
      raise exception 'Unexpected branch sync definition; inspect before applying.';
    end if;
    execute replace(definition,anchor,
      'v_response := public.nhis_branch_history_replay(p_sync_token,p_local_id,p_record);'
      || ' if v_response is not null then return v_response; end if; '
      || ' p_record := public.nhis_branch_pending_payload(p_record); ' || anchor);
  end if;
end $patch$;
notify pgrst,'reload schema';
commit;
