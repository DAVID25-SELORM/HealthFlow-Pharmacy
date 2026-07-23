-- Supabase Advisor hardening pass.
-- This migration changes database security metadata only. It does not alter
-- NHIS pricing, CCC validation, tariff selection, exports, submissions,
-- duplicate detection, or branch-sync business behavior.

-- Views should enforce the permissions/RLS of the querying user.
do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'daily_sales_summary'
      and c.relkind = 'v'
  ) then
    execute 'alter view public.daily_sales_summary set (security_invoker = true)';
  end if;
end;
$$;

-- Fix mutable search_path warnings without recreating function bodies.
-- This keeps existing logic intact while making SECURITY DEFINER/name lookup
-- behavior deterministic.
do $$
declare
  target_function regprocedure;
begin
  for target_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'app_role',
        'user_role',
        'current_user_role',
        'branch_belongs_to_organization',
        'branch_belongs_to_org',
        'update_drug_quantity',
        'update_drug_quantity_after_sale',
        'set_nhia_configuration',
        'set_nhia_configuration_updated_at',
        'generate_claim_number',
        'next_nhis_claim_number',
        'assign_nhis_claim_number',
        'create_claim_transaction',
        'create_sale_transaction'
      )
  loop
    execute format('alter function %s set search_path = public, pg_temp', target_function);
  end loop;
end;
$$;

-- Move pg_trgm out of public when present there. Existing indexes keep working
-- because they reference the operator classes by OID.
create schema if not exists extensions;

do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm'
      and n.nspname = 'public'
  ) then
    alter extension pg_trgm set schema extensions;
  end if;
end;
$$;

-- Explicitly document/maintain RPC-only tables as closed to direct client reads.
-- Edge Functions/service-role and SECURITY DEFINER RPCs continue to work.
do $$
begin
  if to_regclass('public.branch_sync_clients') is not null then
    execute 'drop policy if exists branch_sync_clients_no_direct_client_access on public.branch_sync_clients';
    execute 'create policy branch_sync_clients_no_direct_client_access on public.branch_sync_clients for all to anon, authenticated using (false) with check (false)';
  end if;

  if to_regclass('public.branch_sync_events') is not null then
    execute 'drop policy if exists branch_sync_events_no_direct_client_access on public.branch_sync_events';
    execute 'create policy branch_sync_events_no_direct_client_access on public.branch_sync_events for all to anon, authenticated using (false) with check (false)';
  end if;

  if to_regclass('public.nhis_claim_counters') is not null then
    execute 'drop policy if exists nhis_claim_counters_no_direct_client_access on public.nhis_claim_counters';
    execute 'create policy nhis_claim_counters_no_direct_client_access on public.nhis_claim_counters for all to anon, authenticated using (false) with check (false)';
  end if;

  if to_regclass('public.organization_nhia_integrations') is not null then
    execute 'drop policy if exists organization_nhia_integrations_no_direct_client_access on public.organization_nhia_integrations';
    execute 'create policy organization_nhia_integrations_no_direct_client_access on public.organization_nhia_integrations for all to anon, authenticated using (false) with check (false)';
  end if;
end;
$$;
