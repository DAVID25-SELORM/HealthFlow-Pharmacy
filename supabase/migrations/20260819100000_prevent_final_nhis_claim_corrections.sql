-- Privileged corrections are permitted throughout the internal NHIS workflow,
-- but may not rewrite a claim after external submission/finalization.
-- This guard is server-side so a client cannot bypass it.
-- Final states are checked before any claim, medicine, service, or audit mutation.
do $$
declare
  v_signature regprocedure := 'public.correct_nhis_claim_privileged(uuid,jsonb,jsonb,jsonb,text,timestamptz)'::regprocedure;
  v_definition text;
  v_expected_guard text := 'if v_claim.updated_at is distinct from p_expected_updated_at then
    raise exception ''This claim was modified by another user. Reload the latest version before saving.''
      using errcode = ''40001'';
  end if;';
  v_replacement_guard text := 'if v_claim.updated_at is distinct from p_expected_updated_at then
    raise exception ''This claim was modified by another user. Reload the latest version before saving.''
      using errcode = ''40001'';
  end if;
  if lower(coalesce(v_claim.status, '''')) in (''submitted'', ''paid'', ''approved'', ''accepted'') then
    raise exception ''This claim has already been externally submitted or finalized and cannot be corrected in place.''
      using errcode = ''22023'';
  end if;';
begin
  select pg_get_functiondef(v_signature) into v_definition;

  if position(v_expected_guard in v_definition) = 0 then
    raise exception 'Unexpected % definition: optimistic-lock guard was not found', v_signature;
  end if;

  execute replace(v_definition, v_expected_guard, v_replacement_guard);
end;
$$;

notify pgrst, 'reload schema';
