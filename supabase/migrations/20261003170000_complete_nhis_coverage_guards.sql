-- Final coverage batch: supplied medicines survive administrative claim-status
-- changes in the lookup; duplicate supplied lines cannot bypass same-claim exclusion.
begin;
do $migration$
declare definition text;
  old_filter constant text := $$and lower(coalesce(c.status, '')) not in ('draft', 'pending_serving', 'serving_in_progress', 'rejected', 'cancelled', 'deleted')$$;
  marker constant text := '-- Supplied medicine rows remain coverage evidence regardless of claim status.';
begin
  select pg_get_functiondef('public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)'::regprocedure) into definition;
  if position(marker in definition)=0 then
    if (length(definition)-length(replace(definition,old_filter,'')))/length(old_filter)<>1 then
      raise exception 'Unexpected coverage status filter; inspect before migrating.';
    end if;
    execute replace(definition,old_filter,marker);
  end if;
end;
$migration$;

create or replace function public.guard_nhis_same_claim_supply()
returns trigger language plpgsql security definer
set search_path=public,pg_catalog as $$
begin
  if auth.uid() is null then return new; end if;
  -- Lock the parent so concurrent inserts into the same claim cannot race.
  perform 1 from public.nhis_claims where id=new.claim_id for update;
  if exists (
    select 1 from public.nhis_claim_medicines m
    where m.claim_id=new.claim_id
      and coalesce(m.served_qty,m.dispensed_qty,0)>0
      and lower(coalesce(m.serving_status,'fully_served')) not in ('pending','not_available','not_served')
      and nullif(btrim(m.drug_code),'') is not null
    group by upper(btrim(m.drug_code)) having count(*)>1
  ) then
    raise exception 'Cannot serve duplicate medicine lines in one NHIS claim. Combine the same medicine into one line before serving.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_nhis_same_claim_supply() from public,anon,authenticated;
drop trigger if exists guard_nhis_same_claim_supply on public.nhis_claim_medicines;
-- AFTER checks the resulting rows, including direct serving and replacement RPCs.
create trigger guard_nhis_same_claim_supply after insert or update on public.nhis_claim_medicines
for each row execute function public.guard_nhis_same_claim_supply();
notify pgrst, 'reload schema';
commit;
