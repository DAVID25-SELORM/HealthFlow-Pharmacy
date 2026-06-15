drop policy if exists nhis_claims_delete on public.nhis_claims;
create policy nhis_claims_delete on public.nhis_claims
  for delete to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1
      from public.users
      where id = auth.uid()
        and role = 'admin'
    )
  );

create or replace function public.branch_sync_delete_offline_record(
  p_sync_token text,
  p_entity_type text,
  p_local_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_client public.branch_sync_clients%rowtype;
  v_deleted boolean := false;
begin
  if p_local_id is null then
    raise exception 'Local record ID is required.';
  end if;

  if p_entity_type <> 'nhis_claims' then
    raise exception 'Unsupported offline delete entity type: %', p_entity_type;
  end if;

  v_client := public.get_branch_sync_client(p_sync_token);

  delete from public.nhis_claims
  where id = p_local_id
    and organization_id = v_client.organization_id;

  v_deleted := found;

  return jsonb_build_object(
    'entity_type', p_entity_type,
    'local_id', p_local_id,
    'deleted', v_deleted
  );
end;
$$;

revoke all on function public.branch_sync_delete_offline_record(text, text, uuid) from public;
grant execute on function public.branch_sync_delete_offline_record(text, text, uuid) to anon, authenticated;
