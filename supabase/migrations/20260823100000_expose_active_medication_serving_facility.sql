-- A cross-facility refill alert may identify the serving facility by its
-- public display name, but never by claim number, patient data, or another
-- organisation's internal identifier. The alert remains strict; this changes
-- only the safe source label shown to the clinician.
do $$
declare
  v_overlap_signature regprocedure :=
    'public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)'::regprocedure;
  v_summary_signature regprocedure :=
    'public.get_nhis_patient_active_medications(text,text,date,uuid,uuid)'::regprocedure;
  v_overlap text;
  v_summary text;
  v_generic_label constant text := 'Another participating HealthFlow facility';
begin
  select pg_get_functiondef(v_overlap_signature) into v_overlap;
  select pg_get_functiondef(v_summary_signature) into v_summary;

  if v_overlap not like '%source_label%' then
    raise exception 'Unexpected active-medication overlap definition; source-label patch was not applied';
  end if;

  if v_overlap like '%' || v_generic_label || '%' then
    v_overlap := replace(
      v_overlap,
      E'else ''Another participating HealthFlow facility''',
      E'else coalesce(\n        (select nullif(btrim(o.name), '''')\n         from public.organizations o\n         where o.id = scored_matches.organization_id),\n        ''Another participating HealthFlow facility''\n      )'
    );

    if v_overlap not like '%where o.id = scored_matches.organization_id%' then
      raise exception 'Active-medication overlap definition could not be safely updated with the serving facility name';
    end if;

    execute v_overlap;
  end if;

  if v_summary not like '%source_label%' then
    raise exception 'Unexpected active-medication summary definition; source-label patch was not applied';
  end if;

  if v_summary like '%' || v_generic_label || '%' then
    v_summary := replace(
      v_summary,
      E'else ''Another participating HealthFlow facility''',
      E'else coalesce(\n        (select nullif(btrim(o.name), '''')\n         from public.organizations o\n         where o.id = visible_lines.organization_id),\n        ''Another participating HealthFlow facility''\n      )'
    );

    if v_summary not like '%where o.id = visible_lines.organization_id%' then
      raise exception 'Active-medication summary definition could not be safely updated with the serving facility name';
    end if;

    execute v_summary;
  end if;
end;
$$;

notify pgrst, 'reload schema';
