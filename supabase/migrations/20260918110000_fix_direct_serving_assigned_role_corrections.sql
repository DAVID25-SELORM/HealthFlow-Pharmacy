-- Match privileged correction authorization for users with multiple roles.
-- Preserve the dispensary guard, tenant boundary, and existing audit workflow.
begin;
create or replace function public.prevent_mca_changes_to_direct_nhis_serving()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_claim_id uuid;
  v_direct_served_at timestamptz;
  v_organization_id uuid;
  v_actor_role text;
  v_can_correct boolean;
begin
  v_claim_id := case when tg_op = 'DELETE' then old.claim_id else new.claim_id end;

  select direct_served_at, organization_id
    into v_direct_served_at, v_organization_id
  from public.nhis_claims where id = v_claim_id;

  if v_direct_served_at is not null then
    select u.role,
      u.is_active is true
      and u.organization_id = v_organization_id
      and (u.role in ('admin', 'claims_officer')
        or coalesce(u.assigned_roles, '{}'::text[]) && array['admin', 'claims_officer']::text[])
      into v_actor_role, v_can_correct
    from public.users u where u.id = auth.uid();

    if lower(coalesce(v_actor_role, '')) = 'assistant'
       and not coalesce(v_can_correct, false) then
      raise exception 'This claim was served directly by the Claims Officer and does not require dispensary input.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.prevent_mca_changes_to_direct_nhis_serving() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
