alter table public.pharmacy_settings
  add column if not exists online_payments_enabled boolean not null default false,
  add column if not exists online_payment_default_provider text not null default 'hubtel',
  add column if not exists hubtel_client_id text,
  add column if not exists hubtel_client_secret text,
  add column if not exists hubtel_merchant_account_number text,
  add column if not exists hubtel_webhook_secret text,
  add column if not exists paystack_public_key text,
  add column if not exists paystack_secret_key text,
  add column if not exists payment_return_url text;

alter table public.pharmacy_settings
  drop constraint if exists pharmacy_settings_online_payment_default_provider_check;

alter table public.pharmacy_settings
  add constraint pharmacy_settings_online_payment_default_provider_check
  check (online_payment_default_provider in ('hubtel', 'paystack'));

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  sale_id uuid,
  sale_number text,
  provider text not null check (provider in ('hubtel', 'paystack')),
  payment_method text not null check (payment_method in ('momo', 'card')),
  reference text not null unique,
  amount numeric(12,2) not null default 0,
  currency text not null default 'GHS',
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  authorization_url text,
  access_code text,
  provider_payment_id text,
  sale_payload jsonb not null default '{}'::jsonb,
  request_json jsonb,
  response_json jsonb,
  webhook_json jsonb,
  error_message text,
  created_by uuid references public.users(id) on delete set null,
  paid_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payment_attempts_org_created
  on public.payment_attempts (organization_id, created_at desc);

create index if not exists idx_payment_attempts_reference
  on public.payment_attempts (reference);

alter table public.payment_attempts enable row level security;

drop policy if exists "Users can view organization payment attempts" on public.payment_attempts;
create policy "Users can view organization payment attempts"
  on public.payment_attempts for select
  using (organization_id = public.user_organization_id());
