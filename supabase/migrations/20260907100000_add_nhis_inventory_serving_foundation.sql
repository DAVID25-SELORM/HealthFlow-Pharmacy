-- Foundation only for organization-controlled NHIS inventory consumption.
-- Existing facilities remain stock-neutral: no historical claim or stock data
-- is changed, and the policy remains OFF until a later serving transaction is
-- deployed for both cloud and branch-server paths.

alter table public.pharmacy_settings
  add column if not exists nhis_deduct_inventory_on_serve boolean not null default false;

comment on column public.pharmacy_settings.nhis_deduct_inventory_on_serve is
  'When true, the authoritative NHIS serving transaction deducts actual served quantities from normal inventory. Defaults false to preserve historical stock-neutral NHIS serving.';

-- A change to stock policy is privileged even if a future client accidentally
-- exposes this field to another staff role. The audit event contains neither
-- patient nor medicine data.
create or replace function public.guard_nhis_inventory_policy_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.nhis_deduct_inventory_on_serve is not distinct from old.nhis_deduct_inventory_on_serve then
    return new;
  end if;

  if not exists (
    select 1
    from public.users actor
    where actor.id = auth.uid()
      and actor.organization_id = new.organization_id
      and actor.is_active is distinct from false
      and (
        actor.role in ('admin', 'super_admin')
        or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
      )
  ) then
    raise exception 'Only an active administrator can change the NHIS inventory policy.' using errcode = '42501';
  end if;

  perform public.log_audit_event(
    'settings.nhis_inventory_policy_changed',
    'pharmacy_settings',
    new.id,
    'update',
    jsonb_build_object(
      'organization_id', new.organization_id,
      'previous_value', old.nhis_deduct_inventory_on_serve,
      'new_value', new.nhis_deduct_inventory_on_serve
    ),
    new.organization_id
  );
  return new;
end;
$$;

drop trigger if exists guard_nhis_inventory_policy_change on public.pharmacy_settings;
create trigger guard_nhis_inventory_policy_change
before update of nhis_deduct_inventory_on_serve on public.pharmacy_settings
for each row execute function public.guard_nhis_inventory_policy_change();

-- Every cloud or offline serving request will first acquire one immutable event.
-- The unique tenant/event key is the idempotency boundary; ledger rows are never
-- edited or deleted, including when a future correction creates a compensating
-- event.
create table if not exists public.nhis_serving_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete restrict,
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  idempotency_key text not null,
  source text not null check (source in ('cloud_serve', 'cloud_direct_serve', 'branch_offline_sync')),
  actor_user_id uuid references auth.users(id) on delete set null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create index if not exists idx_nhis_serving_events_claim_created
  on public.nhis_serving_events (claim_id, created_at desc);

create table if not exists public.nhis_inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete restrict,
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  serving_event_id uuid not null references public.nhis_serving_events(id) on delete restrict,
  inventory_drug_id uuid not null references public.drugs(id) on delete restrict,
  claim_medicine_key text not null,
  quantity_delta numeric not null check (quantity_delta <> 0),
  movement_type text not null check (movement_type in ('nhis_dispensing', 'nhis_dispensing_reversal')),
  reversal_of_ledger_id uuid references public.nhis_inventory_ledger(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (serving_event_id, inventory_drug_id, claim_medicine_key)
);

create index if not exists idx_nhis_inventory_ledger_claim_created
  on public.nhis_inventory_ledger (claim_id, created_at desc);
create index if not exists idx_nhis_inventory_ledger_drug_created
  on public.nhis_inventory_ledger (inventory_drug_id, created_at desc);

alter table public.nhis_serving_events enable row level security;
alter table public.nhis_inventory_ledger enable row level security;
revoke all on public.nhis_serving_events, public.nhis_inventory_ledger from public, anon, authenticated;

comment on table public.nhis_serving_events is
  'Immutable, tenant-scoped idempotency boundary for cloud and offline NHIS serving.';
comment on table public.nhis_inventory_ledger is
  'Immutable NHIS inventory effects. Corrections must add compensating rows; they never rewrite history.';

notify pgrst, 'reload schema';
