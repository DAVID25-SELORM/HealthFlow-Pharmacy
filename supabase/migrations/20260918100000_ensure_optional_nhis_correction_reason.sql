-- Ensure privileged NHIS corrections match the UI contract: reason is optional.
-- Idempotent compatibility migration for projects where the earlier patch was not applied.
begin;
alter table public.nhis_claim_corrections alter column reason drop not null;
alter table public.nhis_claim_corrections drop constraint if exists nhis_claim_corrections_reason_check;
do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_guard text := 'if nullif(btrim(p_reason), '''') is null then';
begin
  foreach v_signature in array array[
    'public.record_nhis_claim_correction(uuid,text,jsonb)'::regprocedure,
    'public.correct_nhis_claim_privileged(uuid,jsonb,jsonb,jsonb,text,timestamptz)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    if position(v_guard in v_definition) > 0 then
      v_definition := regexp_replace(v_definition,
        E'\\s*if nullif\\(btrim\\(p_reason\\), ''''\\) is null then\\s*raise exception ''Reason for correction is required\\.''(?: using errcode = ''22023'')?;\\s*end if;\\s*', E'\\n', 1);
      execute v_definition;
    end if;
  end loop;
end $$;
notify pgrst, 'reload schema';
commit;
