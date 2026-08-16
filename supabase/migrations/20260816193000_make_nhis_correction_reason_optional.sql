-- Claims officers may optionally document why a saved NHIS claim was edited.
-- The immutable audit row, actor, timestamp, old/new values, organization
-- isolation, and atomic correction workflow remain unchanged.

alter table public.nhis_claim_corrections
  alter column reason drop not null;

alter table public.nhis_claim_corrections
  drop constraint if exists nhis_claim_corrections_reason_check;

do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_record_guard text := 'if nullif(btrim(p_reason), '''') is null then
    raise exception ''Reason for correction is required.'';
  end if;';
  v_privileged_guard text := 'if nullif(btrim(p_reason), '''') is null then
    raise exception ''Reason for correction is required.'' using errcode = ''22023'';
  end if;';
begin
  foreach v_signature in array array[
    'public.record_nhis_claim_correction(uuid,text,jsonb)'::regprocedure,
    'public.correct_nhis_claim_privileged(uuid,jsonb,jsonb,jsonb,text,timestamptz)'::regprocedure
  ]
  loop
    select pg_get_functiondef(v_signature) into v_definition;

    if position(v_record_guard in v_definition) > 0 then
      v_definition := replace(v_definition, v_record_guard, '');
    elsif position(v_privileged_guard in v_definition) > 0 then
      v_definition := replace(v_definition, v_privileged_guard, '');
    else
      raise exception 'Unexpected % definition: correction reason guard was not found', v_signature;
    end if;

    v_definition := replace(
      v_definition,
      'btrim(p_reason)',
      'nullif(btrim(p_reason), '''')'
    );
    execute v_definition;
  end loop;
end;
$$;

comment on column public.nhis_claim_corrections.reason is
  'Optional user-supplied context for an immutable privileged NHIS claim correction.';

notify pgrst, 'reload schema';
