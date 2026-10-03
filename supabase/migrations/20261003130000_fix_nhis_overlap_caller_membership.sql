-- The deployed date patch declared this variable but its CRLF-sensitive
-- replacement did not insert the assignment. Preserve the deployed coverage
-- calculation and derive membership before any lookup (including empty input).
begin;
do $migration$
declare
  v_definition text;
  v_anchor constant text := '  if (v_medicine_code';
  v_marker constant text := '-- Enforce authenticated coverage caller membership.';
begin
  select pg_get_functiondef(
    'public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)'::regprocedure
  ) into v_definition;
  if position(v_marker in v_definition) = 0 then
    if position('v_caller_organization_id uuid' in v_definition) = 0
       or (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
      raise exception 'Unexpected coverage function definition; inspect before applying the membership patch.';
    end if;
    v_definition := replace(v_definition, v_anchor, $patch$  -- Enforce authenticated coverage caller membership.
  select u.organization_id into v_caller_organization_id
  from public.users u
  where u.id = auth.uid() and u.is_active = true;
  if v_caller_organization_id is null then
    raise exception 'Active organization membership is required.' using errcode = '42501';
  end if;

  if (v_medicine_code$patch$);
    execute v_definition;
  end if;
end;
$migration$;
revoke all on function public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text) from public, anon;
grant execute on function public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
