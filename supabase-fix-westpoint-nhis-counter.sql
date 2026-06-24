-- Westpoint NHIS claim-number audit and counter repair
-- Run this in the Supabase SQL editor for the live HealthFlow project.
--
-- This does not delete or renumber existing claims. It only ensures the next
-- generated NHIS-000000 number for Westpoint continues after the highest saved
-- numeric NHIS claim number.

begin;

-- 0) Install the per-organization NHIS counter pieces if the production
-- migration has not been applied yet.
create table if not exists public.nhis_claim_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_number integer not null default 0
);

alter table public.nhis_claim_counters enable row level security;

create or replace function public.next_nhis_claim_number(org_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  next_num integer;
begin
  if org_id is null then
    raise exception 'organization_id is required to generate an NHIS claim number.';
  end if;

  insert into public.nhis_claim_counters (organization_id, last_number)
  values (org_id, 1)
  on conflict (organization_id) do update
    set last_number = nhis_claim_counters.last_number + 1
  returning last_number into next_num;

  return 'NHIS-' || lpad(next_num::text, 6, '0');
end;
$$;

create or replace function public.assign_nhis_claim_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.claim_number is null or new.claim_number = '' then
    new.claim_number := public.next_nhis_claim_number(new.organization_id);
  end if;
  return new;
end;
$$;

drop trigger if exists assign_nhis_claim_number_trigger on public.nhis_claims;
create trigger assign_nhis_claim_number_trigger
  before insert on public.nhis_claims
  for each row
  execute function public.assign_nhis_claim_number();

alter table public.nhis_claims
  alter column claim_number drop default;

-- Seed all existing organizations once, so other pharmacies are not left behind.
insert into public.nhis_claim_counters (organization_id, last_number)
select
  organization_id,
  max(substring(claim_number from 6)::integer)
from public.nhis_claims
where claim_number ~ '^NHIS-[0-9]{6}$'
  and organization_id is not null
group by organization_id
on conflict (organization_id) do update
set last_number = greatest(
  public.nhis_claim_counters.last_number,
  excluded.last_number
);

-- 1) Confirm the Westpoint organization row that will be repaired.
select
  id,
  name,
  organization_type,
  created_at
from public.organizations
where
  name ilike '%west%point%'
  or name ilike '%westpoint%'
order by created_at desc;

-- 2) Audit current Westpoint NHIS claim-number state.
with westpoint_orgs as (
  select id, name
  from public.organizations
  where
    name ilike '%west%point%'
    or name ilike '%westpoint%'
),
numeric_claims as (
  select
    c.organization_id,
    c.claim_number,
    substring(c.claim_number from 6)::integer as claim_no,
    c.created_at
  from public.nhis_claims c
  join westpoint_orgs o on o.id = c.organization_id
  where c.claim_number ~ '^NHIS-[0-9]{6}$'
)
select
  o.id as organization_id,
  o.name,
  count(c.claim_number) as numeric_nhis_claims,
  min(c.claim_no) as first_claim_no,
  max(c.claim_no) as last_claim_no,
  counter.last_number as current_counter,
  coalesce(max(c.claim_no), 0) as counter_should_be
from westpoint_orgs o
left join numeric_claims c on c.organization_id = o.id
left join public.nhis_claim_counters counter on counter.organization_id = o.id
group by o.id, o.name, counter.last_number
order by o.name;

-- 3) Check if Westpoint has duplicate NHIS claim numbers.
with westpoint_orgs as (
  select id, name
  from public.organizations
  where
    name ilike '%west%point%'
    or name ilike '%westpoint%'
)
select
  o.name,
  c.claim_number,
  count(*) as duplicate_count,
  array_agg(c.id order by c.created_at) as claim_ids
from public.nhis_claims c
join westpoint_orgs o on o.id = c.organization_id
where c.claim_number is not null
group by o.name, c.claim_number
having count(*) > 1
order by c.claim_number;

-- 4) Repair Westpoint's counter to the highest saved numeric NHIS claim number.
with westpoint_orgs as (
  select id
  from public.organizations
  where
    name ilike '%west%point%'
    or name ilike '%westpoint%'
),
max_claims as (
  select
    o.id as organization_id,
    coalesce(max(substring(c.claim_number from 6)::integer), 0) as max_claim_no
  from westpoint_orgs o
  left join public.nhis_claims c
    on c.organization_id = o.id
   and c.claim_number ~ '^NHIS-[0-9]{6}$'
  group by o.id
)
insert into public.nhis_claim_counters (organization_id, last_number)
select organization_id, max_claim_no
from max_claims
on conflict (organization_id) do update
set last_number = greatest(
  public.nhis_claim_counters.last_number,
  excluded.last_number
);

-- 5) Confirm the repaired counter.
select
  o.id as organization_id,
  o.name,
  counter.last_number,
  'NHIS-' || lpad((counter.last_number + 1)::text, 6, '0') as next_claim_number
from public.organizations o
join public.nhis_claim_counters counter on counter.organization_id = o.id
where
  o.name ilike '%west%point%'
  or o.name ilike '%westpoint%'
order by o.name;

commit;
