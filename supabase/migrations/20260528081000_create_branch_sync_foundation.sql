-- Branch-sync foundation deliberately precedes all branch RPC migrations.
-- It only introduces credential and idempotency storage; it does not recreate
-- legacy sale, stock, claim, or NHIS RPC bodies.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.branch_sync_clients (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  token_hash text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  activation_expires_at timestamptz
);

create index if not exists idx_branch_sync_clients_org_branch
  on public.branch_sync_clients (organization_id, branch_id)
  where is_active = true;

alter table public.branch_sync_clients enable row level security;
revoke all on table public.branch_sync_clients from anon, authenticated;

create table if not exists public.branch_sync_events (
  id uuid primary key default extensions.gen_random_uuid(),
  sync_client_id uuid not null references public.branch_sync_clients(id) on delete cascade,
  event_type text not null,
  local_id uuid not null,
  remote_id uuid,
  remote_number text,
  response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (sync_client_id, event_type, local_id)
);

alter table public.branch_sync_events enable row level security;
revoke all on table public.branch_sync_events from anon, authenticated;

create or replace function public.branch_sync_token_hash(p_token text)
returns text
language plpgsql
stable
set search_path = public, extensions
as $$
begin
  if nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'Branch sync token is required.';
  end if;

  return encode(digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
end;
$$;

revoke all on function public.branch_sync_token_hash(text) from public;
