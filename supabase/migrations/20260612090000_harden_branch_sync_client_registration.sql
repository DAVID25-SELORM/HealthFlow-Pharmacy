begin;

create or replace function public.create_branch_sync_client(
  p_name text,
  p_organization_id uuid,
  p_branch_id uuid,
  p_plain_token text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    raise exception 'Client name is required.';
  end if;

  if p_organization_id is null or p_branch_id is null then
    raise exception 'Organization and branch are required.';
  end if;

  if length(btrim(coalesce(p_plain_token, ''))) < 32 then
    raise exception 'Branch sync token must be at least 32 characters.';
  end if;

  if not exists (
    select 1
    from public.branches
    where id = p_branch_id
      and organization_id = p_organization_id
  ) then
    raise exception 'Branch does not belong to the organization.';
  end if;

  update public.branch_sync_clients
  set is_active = false
  where organization_id = p_organization_id
    and branch_id = p_branch_id
    and lower(btrim(name)) = lower(v_name)
    and is_active = true;

  insert into public.branch_sync_clients (
    name,
    organization_id,
    branch_id,
    token_hash,
    is_active
  )
  values (
    v_name,
    p_organization_id,
    p_branch_id,
    public.branch_sync_token_hash(p_plain_token),
    true
  )
  returning id into v_client_id;

  return v_client_id;
end;
$$;

revoke all on function public.create_branch_sync_client(text, uuid, uuid, text) from public;
revoke all on function public.create_branch_sync_client(text, uuid, uuid, text) from anon, authenticated;
grant execute on function public.create_branch_sync_client(text, uuid, uuid, text) to service_role;

commit;
