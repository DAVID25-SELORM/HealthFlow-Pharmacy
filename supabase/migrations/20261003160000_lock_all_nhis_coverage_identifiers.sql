-- Serialize requests that share either member number OR HIN.
-- The old coalesce lock chose only one identifier, unlike the overlap lookup.
begin;
create or replace function public.lock_nhis_coverage_identifiers(p_member text,p_hin text)
returns void language plpgsql security definer
set search_path=public,pg_catalog as $$
declare lock_key bigint;
begin
  -- Numeric ordering prevents opposite member/HIN ordering from deadlocking.
  for lock_key in
    select distinct hashtextextended('nhis-coverage:' || normalized,0) as key
    from (
      select upper(regexp_replace(coalesce(value,''),'[^A-Za-z0-9]','','g')) as normalized
      from unnest(array[p_member,p_hin]) as identifiers(value)
    ) keys where normalized<>'' order by key
  loop
    perform pg_advisory_xact_lock(lock_key);
  end loop;
end;
$$;
revoke all on function public.lock_nhis_coverage_identifiers(text,text) from public,anon,authenticated;
do $migration$
declare
  target record;
  definition text;
  old_lock text;
  matches integer;
begin
  for target in select * from (values
    ('public.guard_nhis_active_coverage_on_serve()',
     'perform public.lock_nhis_coverage_identifiers(v_claim.member_no,v_claim.hin);'),
    ('public.guard_nhis_coverage_claim_edit()',
     'perform public.lock_nhis_coverage_identifiers(new.member_no,new.hin);')
  ) as targets(signature,replacement)
  loop
    select pg_get_functiondef(target.signature::regprocedure) into definition;
    if position(target.replacement in definition)>0 then continue; end if;
    select count(*),min(m[1]) into matches,old_lock
    from regexp_matches(definition,'perform pg_advisory_xact_lock[(][^;]+;', 'g') as m;
    if matches<>1 or position('nhis-coverage:' in old_lock)=0 then
      raise exception 'Unexpected identifier lock in %. Inspect before migrating.',target.signature;
    end if;
    execute replace(definition,old_lock,target.replacement);
  end loop;
end;
$migration$;
notify pgrst, 'reload schema';
commit;
