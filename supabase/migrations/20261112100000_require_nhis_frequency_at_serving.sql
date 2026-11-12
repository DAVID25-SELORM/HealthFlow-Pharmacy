-- Require a dosage schedule/frequency and a valid duration at the serving
-- boundary. Draft intake and unchanged historical corrections remain possible;
-- a new serving transition must carry complete medicine directions.
begin;

create or replace function public.is_valid_nhis_clinical_frequency(p_frequency text)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select nullif(btrim(p_frequency), '') is not null;
$$;

create or replace function public.guard_nhis_duration_integrity()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_claim_id uuid; v_draft boolean; v_serving boolean;
begin
  if tg_table_name = 'nhis_claims' then
    -- Metadata corrections do not constitute another serving/export transition.
    if tg_op = 'UPDATE' and new.status is not distinct from old.status
      and new.serving_status is not distinct from old.serving_status then return null; end if;
    v_claim_id := new.id;
  else
    v_claim_id := new.claim_id;
    -- A valid individual correction must remain possible while other legacy
    -- lines await review. Unchanged invalid directions may be retained only
    -- when this update does not add serving or move the line to another claim.
    if tg_op = 'UPDATE' and new.claim_id = old.claim_id
      and new.served_qty is not distinct from old.served_qty
      and new.serving_status is not distinct from old.serving_status then
      if (public.is_valid_nhis_clinical_duration(new.duration)
          and public.is_valid_nhis_clinical_frequency(new.frequency))
        or (new.duration is not distinct from old.duration
          and new.frequency is not distinct from old.frequency) then return null; end if;
    end if;
  end if;
  select status = 'draft', serving_status in ('fully_served','partially_served')
    into v_draft, v_serving from public.nhis_claims where id = v_claim_id;
  if not found then return null; end if;
  if coalesce(v_draft, false) and not coalesce(v_serving, false)
    and not exists (select 1 from public.nhis_claim_medicines where claim_id = v_claim_id
      and (coalesce(served_qty, 0) > 0 or serving_status in ('fully_served','partially_served')))
    then return null;
  end if;
  if exists (select 1 from public.nhis_claim_medicines where claim_id = v_claim_id
    and not public.is_valid_nhis_clinical_frequency(frequency)) then
    raise exception 'Dosage schedule/frequency is required before completing or serving this claim. Keep incomplete intake as Draft.' using errcode = '23514';
  end if;
  if exists (select 1 from public.nhis_claim_medicines where claim_id = v_claim_id
    and not public.is_valid_nhis_clinical_duration(duration)) then
    raise exception 'Valid medicine duration is required before completing or serving this claim. Keep incomplete intake as Draft.' using errcode = '23514';
  end if;
  return null;
end $$;

-- The active-coverage trigger is immediate, so direct/server serving fails with
-- a useful directions error before any stock or coverage work is accepted.
do $patch$
declare definition text;
  anchor text := E'  select * into strict v_claim from public.nhis_claims where id = new.claim_id;';
  replacement text := E'  if not public.is_valid_nhis_clinical_frequency(new.frequency) then
    raise exception ''Dosage schedule/frequency is required before serving this medicine.'' using errcode = ''23514'';
  end if;
  if not public.is_valid_nhis_clinical_duration(new.duration) then
    raise exception ''Valid medicine duration is required before serving this medicine.'' using errcode = ''23514'';
  end if;

  select * into strict v_claim from public.nhis_claims where id = new.claim_id;';
begin
  select pg_get_functiondef('public.guard_nhis_active_coverage_on_serve()'::regprocedure) into definition;
  if position('is_valid_nhis_clinical_frequency(new.frequency)' in definition) = 0 then
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
      raise exception 'Unexpected serving guard; inspect before applying frequency/duration enforcement.';
    end if;
    execute replace(definition, anchor, replacement);
  end if;
end
$patch$;

-- Weekly is represented as one administration every seven days. The stored
-- frequency unit remains DAILY because the Claim-it serializer stores the
-- normalized per-day rate; the description retains the provider-facing text.
do $weekly$
declare signature text;
  definition text;
  anchor text := $fragment$
        when candidate_raw.frequency_text ~ '\m(od)\M' or candidate_raw.frequency_text like '%daily%' or candidate_raw.frequency_text like '%once%' or candidate_raw.frequency_text like '%nocte%' then 1::numeric
$fragment$;
  replacement text := $fragment$
        when candidate_raw.frequency_text ~ '\m(weekly|once a week|once weekly)\M' then (1.0 / 7.0)::numeric
$fragment$ || anchor;
begin
  foreach signature in array array[
    'public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)',
    'public.get_nhis_patient_active_medications(text,text,date,uuid,uuid)'
  ] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    if position('frequency_text ~ ''\m(weekly|once a week|once weekly)\M''' in definition) = 0 then
      if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
        raise exception 'Unexpected active medication definition; inspect before applying weekly frequency support: %', signature;
      end if;
      execute replace(definition, anchor, replacement);
    end if;
  end loop;
end
$weekly$;

revoke all on function public.is_valid_nhis_clinical_frequency(text) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
