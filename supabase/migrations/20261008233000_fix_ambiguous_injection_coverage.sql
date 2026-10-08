-- A bare injection dose may be IU, mg or mL, not a vial count. Returning NULL
-- makes the existing overlap functions use the recorded treatment duration.
begin;
create or replace function public.nhis_coverage_dose_units(p_dose text,p_strength text,p_form text,p_description text)
returns numeric language plpgsql immutable set search_path=public,pg_catalog as $$
declare
  dose text := lower(btrim(coalesce(p_dose,'')));
  strength text := lower(btrim(coalesce(p_strength,'')));
  formulation text := lower(coalesce(p_form,'') || ' ' || coalesce(p_description,''));
  solid boolean;
  dm text[]; sm text[]; d numeric; s numeric;
begin
  -- Explicit non-solid forms take priority over contradictory dose labels.
  if formulation ~ '\m(inj|injections?|injectable|infusions?|intravenous|intramuscular|vials?|ampoules?|ampules?|amps?|syringes?|solutions?|suspensions?|syrups?|liquids?|drops?|creams?|ointments?|gels?|lotions?)\M'
    or strength ~ '[/]\s*(ml|l)\M' then return null; end if;
  solid := formulation ~ '\m(tablets?|capsules?|tabs?|caps?)\M';
  if dose ~ '^[0-9]+([.][0-9]+)?\s*(tabs?|tablets?|caps?|capsules?)$'
    or (solid and dose ~ '^[0-9]+([.][0-9]+)?$') then
    return nullif(substring(dose from '^([0-9]+(?:[.][0-9]+)?)')::numeric,0);
  end if;
  -- Unknown formulations also use duration: never guess what a number measures.
  if not solid then return null; end if;
  dm := regexp_match(dose,'^([0-9]+(?:[.][0-9]+)?)\s*(mg|mcg|g)$');
  sm := regexp_match(strength,'^([0-9]+(?:[.][0-9]+)?)\s*(mg|mcg|g)$');
  if dm is null or sm is null then return null; end if;
  d := dm[1]::numeric * case dm[2] when 'g' then 1000 when 'mcg' then 0.001 else 1 end;
  s := sm[1]::numeric * case sm[2] when 'g' then 1000 when 'mcg' then 0.001 else 1 end;
  return nullif(d,0)/nullif(s,0);
end $$;

-- This is a follow-up to the dose-unit patch, not a substitute for it or for
-- the authoritative serving guards. Refuse to imply protection if absent.
do $$
declare signature text;
begin
  foreach signature in array array[
    'public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)',
    'public.get_nhis_patient_active_medications(text,text,date,uuid,uuid)'
  ] loop
    if position('nhis_coverage_dose_units' in pg_get_functiondef(signature::regprocedure)) = 0 then
      raise exception 'Apply the 20261006223000 dose-unit migration first: %', signature;
    end if;
  end loop;
end $$;
notify pgrst, 'reload schema';
commit;
