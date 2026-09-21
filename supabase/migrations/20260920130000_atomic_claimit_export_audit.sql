-- Validate in bounded chunks, but commit the entire artifact's audit in one RPC.
-- A failure in any chunk rolls back every event written by this call.
begin;
create or replace function public.record_nhis_cxf_export_atomic(
  p_claim_ids uuid[], p_fingerprints jsonb, p_artifact_sha256 text,
  p_reexport_reason text default null
)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare sorted_ids uuid[]; offset_index integer;
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  if coalesce(cardinality(p_claim_ids),0) not between 1 and 10000 then
    raise exception 'Select between 1 and 10000 claims per artifact.';
  end if;
  select array_agg(id order by id) into sorted_ids from unnest(p_claim_ids) id;
  if cardinality(sorted_ids) <> (select count(distinct id) from unnest(sorted_ids) id) then
    raise exception 'Duplicate or null claim IDs.';
  end if;
  if jsonb_typeof(p_fingerprints) is distinct from 'object' then
    raise exception 'Expected claim fingerprints are required.';
  end if;
  -- Global ordering prevents overlapping artifact calls locking chunks in
  -- opposite order. Existing inner RPC checks authorization and readiness.
  offset_index:=1;
  while offset_index<=cardinality(sorted_ids) loop
    perform public.record_nhis_cxf_export(sorted_ids[offset_index:offset_index+499],
      p_fingerprints,p_artifact_sha256,p_reexport_reason);
    offset_index:=offset_index+500;
  end loop;
end $$;
revoke all on function public.record_nhis_cxf_export_atomic(uuid[],jsonb,text,text) from public,anon;
grant execute on function public.record_nhis_cxf_export_atomic(uuid[],jsonb,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
