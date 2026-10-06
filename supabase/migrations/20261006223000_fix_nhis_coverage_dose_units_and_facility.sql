-- Calculate supply in dosage units, never divide capsule counts by milligrams.
begin;
create or replace function public.nhis_coverage_dose_units(p_dose text,p_strength text,p_form text,p_description text)
returns numeric language plpgsql immutable set search_path=public,pg_catalog as $$
declare
 dose text:=lower(btrim(coalesce(p_dose,'')));
 strength text:=lower(btrim(coalesce(p_strength,'')));
 dm text[]; sm text[]; d numeric; s numeric;
begin
 -- Plain numbers and explicit tablet/capsule counts are already dosage units.
 if dose ~ '^[0-9]+([.][0-9]+)?\s*(tabs?|tablets?|caps?|capsules?)?$' then
  return nullif(substring(dose from '^([0-9]+(?:[.][0-9]+)?)')::numeric,0);
 end if;
 -- Mass-to-count conversion is valid only for a single-strength solid dose.
 if lower(coalesce(p_form,'')||' '||coalesce(p_description,'')) !~ '\m(tablets?|capsules?|tabs?|caps?)\M' then return null; end if;
 dm:=regexp_match(dose,'^([0-9]+(?:[.][0-9]+)?)\s*(mg|mcg|g)$');
 sm:=regexp_match(strength,'^([0-9]+(?:[.][0-9]+)?)\s*(mg|mcg|g)$');
 if dm is null or sm is null then return null; end if;
 d:=dm[1]::numeric * case dm[2] when 'g' then 1000 when 'mcg' then 0.001 else 1 end;
 s:=sm[1]::numeric * case sm[2] when 'g' then 1000 when 'mcg' then 0.001 else 1 end;
 return nullif(d,0)/nullif(s,0);
end $$;
-- Unknown, topical, liquid, and combination doses fall back to recorded duration.
do $patch$
declare signature text; definition text; row_alias text;
 old_dose text := $old$coalesce(nullif(substring(candidate_raw.dose_text from '(\d+(?:\.\d+)?)'), '')::numeric, 1)::numeric as dose_units$old$;
begin
 foreach signature in array array[
 'public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)',
 'public.get_nhis_patient_active_medications(text,text,date,uuid,uuid)'] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  row_alias:=case when signature like '%check_nhis%' then 'scored_matches' else 'visible_lines' end;
  if position(old_dose in definition)=0 then raise exception 'Unexpected dose calculation in %',signature; end if;
  definition:=replace(definition,old_dose,
   'public.nhis_coverage_dose_units(candidate_raw.dose_text,candidate_raw.strength_key,candidate_raw.dosage_form_key,candidate_raw.description) as dose_units');
  if position('then ''This HealthFlow facility''' in definition)=0 then raise exception 'Unexpected facility label in %',signature; end if;
  definition:=replace(definition,'then ''This HealthFlow facility''',
   format('then coalesce((select nullif(btrim(o.name), '''') from public.organizations o where o.id = %s.organization_id), ''This HealthFlow facility'')',row_alias));
  execute definition;
 end loop;
end $patch$;
notify pgrst,'reload schema';
commit;
