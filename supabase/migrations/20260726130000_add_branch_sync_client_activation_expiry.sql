-- Branch sync credentials expire before first use if left unclaimed.
-- Registering a machine issues a token that must be put to work on the
-- facility server within the activation window; once the token has
-- successfully authenticated at least once, it behaves exactly as before
-- (no expiry). Pre-existing rows (activation_expires_at is null) are
-- unaffected -- this only changes newly registered clients.
-- This does not alter CCC, NHIS pricing, tariffs, export, submission,
-- duplicate detection, or existing sync payload logic.

alter table public.branch_sync_clients
  add column if not exists activation_expires_at timestamptz;

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
    is_active,
    activation_expires_at
  )
  values (
    v_name,
    p_organization_id,
    p_branch_id,
    public.branch_sync_token_hash(p_plain_token),
    true,
    now() + interval '48 hours'
  )
  returning id into v_client_id;

  return v_client_id;
end;
$$;

revoke all on function public.create_branch_sync_client(text, uuid, uuid, text) from public;
revoke all on function public.create_branch_sync_client(text, uuid, uuid, text) from anon, authenticated;
grant execute on function public.create_branch_sync_client(text, uuid, uuid, text) to service_role;

create or replace function public.get_branch_sync_client(p_plain_token text)
returns public.branch_sync_clients
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client public.branch_sync_clients%rowtype;
begin
  select *
  into v_client
  from public.branch_sync_clients
  where token_hash = public.branch_sync_token_hash(p_plain_token)
    and is_active = true;

  if not found then
    raise exception 'Invalid or inactive branch sync token.';
  end if;

  if v_client.last_seen_at is null
    and v_client.activation_expires_at is not null
    and v_client.activation_expires_at < now()
  then
    raise exception 'This branch sync credential expired before first use. Ask an administrator to re-register this machine.';
  end if;

  update public.branch_sync_clients
  set last_seen_at = now()
  where id = v_client.id;

  v_client.last_seen_at := now();
  return v_client;
end;
$$;

revoke all on function public.get_branch_sync_client(text) from public;
revoke all on function public.get_branch_sync_client(text) from anon, authenticated;
grant execute on function public.get_branch_sync_client(text) to service_role;

comment on column public.branch_sync_clients.activation_expires_at is
  'A newly registered branch sync token must be used at least once before this time or get_branch_sync_client() rejects it. Cleared in effect once last_seen_at is set (no expiry applies after first successful use). Null for clients registered before this column existed.';
