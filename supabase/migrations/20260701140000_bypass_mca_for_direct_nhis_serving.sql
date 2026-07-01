-- A claim served directly by a Claims Officer is complete at the dispensary
-- stage. MCA users must not reopen or replace its medicine-serving records.
-- Claims Officers and administrators retain their existing correction access.

create or replace function public.prevent_mca_changes_to_direct_nhis_serving()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id uuid;
  v_direct_served_at timestamptz;
  v_actor_role text;
begin
  v_claim_id := case when tg_op = 'DELETE' then old.claim_id else new.claim_id end;

  select direct_served_at
  into v_direct_served_at
  from public.nhis_claims
  where id = v_claim_id;

  if v_direct_served_at is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select role
  into v_actor_role
  from public.users
  where id = auth.uid();

  if lower(coalesce(v_actor_role, '')) = 'assistant' then
    raise exception 'This claim was served directly by the Claims Officer and does not require MCA input.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_mca_direct_nhis_medicine_changes
  on public.nhis_claim_medicines;

create trigger prevent_mca_direct_nhis_medicine_changes
before insert or update or delete on public.nhis_claim_medicines
for each row
execute function public.prevent_mca_changes_to_direct_nhis_serving();

revoke all on function public.prevent_mca_changes_to_direct_nhis_serving() from public;

comment on function public.prevent_mca_changes_to_direct_nhis_serving() is
  'Prevents MCA users from modifying medicines on claims already served directly by Claims Officers.';
