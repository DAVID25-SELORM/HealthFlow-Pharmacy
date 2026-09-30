-- Direct serving must not bypass required intake identifiers.
create or replace function public.guard_nhis_direct_serving_identifiers()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  if new.direct_served_at is not null then
    if nullif(btrim(new.folder_no), '') is null then
      raise exception 'Folder number is required before serving this NHIS claim.' using errcode = '23514';
    end if;
    if regexp_replace(coalesce(new.ccc_no, ''), '[^0-9]', '', 'g') !~ '^[0-9]{5}$' then
      raise exception 'CCC/CC code must contain exactly 5 digits before serving this NHIS claim.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_nhis_direct_serving_identifiers on public.nhis_claims;
create trigger guard_nhis_direct_serving_identifiers before insert or update on public.nhis_claims
for each row execute function public.guard_nhis_direct_serving_identifiers();
revoke all on function public.guard_nhis_direct_serving_identifiers() from public, anon, authenticated;
