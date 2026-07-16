-- Text-only cleanup: keep existing NHIS correction logic intact while replacing
-- old MCA wording with dispensary wording in database-facing messages/comments.

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
    raise exception 'This claim was served directly by the Claims Officer and does not require dispensary input.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.prevent_mca_changes_to_direct_nhis_serving() is
  'Prevents dispensary users from modifying medicines on claims already served directly by Claims Officers.';

comment on column public.nhis_claims.mca_edit_reopened_until is
  'When set and in the future, re-opens the dispensary medication edit window (12h grace granted by admin/claims officer).';
comment on column public.nhis_claims.mca_edit_reopen_reason is
  'Reason captured when an admin/claims officer re-opened the dispensary edit window.';
comment on column public.nhis_claims.mca_edit_reopened_by is
  'User who re-opened the dispensary edit window.';
