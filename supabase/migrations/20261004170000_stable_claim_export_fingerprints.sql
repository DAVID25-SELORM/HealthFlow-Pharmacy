-- Preserve clinical signing hashes; normalize administrative claim fields inside export envelopes too.
begin;
create or replace function public.claimit_fingerprint(p_snapshot jsonb)
returns text language sql immutable set search_path=public,pg_catalog as $$
 select encode(sha256(convert_to((
   case when jsonb_typeof(p_snapshot->'claim')='object' and p_snapshot ? 'config'
     then jsonb_set(p_snapshot,'{claim}',
       (p_snapshot->'claim') - array['status','updated_at','rejection_reason'])
     else p_snapshot
   end - array['status','updated_at','rejection_reason']
 )::text,'UTF8')),'hex')
$$;
-- Existing grants stay unchanged. Claim values, medicines, services and configuration remain checked.
notify pgrst,'reload schema';
commit;
