-- Repair existing NHIS medicine durations before CLAIM-it export while
-- preserving a per-line immutable audit trail for every organization.

create table if not exists public.nhis_duration_repair_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  medicine_id uuid not null references public.nhis_claim_medicines(id) on delete restrict,
  previous_value text,
  new_value text not null,
  repair_type text not null check (repair_type in ('automatic', 'manual')),
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists idx_nhis_duration_repair_audit_org_created
  on public.nhis_duration_repair_audit (organization_id, created_at desc);
create index if not exists idx_nhis_duration_repair_audit_claim_created
  on public.nhis_duration_repair_audit (claim_id, created_at desc);

alter table public.nhis_duration_repair_audit enable row level security;
revoke all on public.nhis_duration_repair_audit from public, anon, authenticated;

drop policy if exists nhis_duration_repair_audit_select_org on public.nhis_duration_repair_audit;
create policy nhis_duration_repair_audit_select_org
on public.nhis_duration_repair_audit
for select
to authenticated
using (
  exists (
    select 1
    from public.users viewer
    where viewer.id = auth.uid()
      and viewer.organization_id = nhis_duration_repair_audit.organization_id
      and (
        viewer.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
        or coalesce(viewer.assigned_roles, '{}'::text[])
          && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
      )
  )
);

grant select on public.nhis_duration_repair_audit to authenticated;

create or replace function public.repair_nhis_claim_medicine_durations(p_repairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.users%rowtype;
  v_repair jsonb;
  v_medicine public.nhis_claim_medicines%rowtype;
  v_organization_id uuid;
  v_old_duration text;
  v_new_duration text;
  v_repair_type text;
  v_result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select * into v_actor from public.users where id = auth.uid();
  if v_actor.id is null or not (
    v_actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer')
    or coalesce(v_actor.assigned_roles, '{}'::text[])
      && array['admin', 'super_admin', 'pharmacist', 'claims_officer']::text[]
  ) then
    raise exception 'You do not have permission to repair NHIS medicine durations.' using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_repairs, 'null'::jsonb)) <> 'array' then
    raise exception 'Duration repairs must be supplied as an array.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_repairs) = 0 then
    raise exception 'At least one duration repair is required.' using errcode = '22023';
  end if;

  for v_repair in select value from jsonb_array_elements(p_repairs)
  loop
    v_old_duration := nullif(btrim(v_repair->>'old_duration'), '');
    v_new_duration := nullif(btrim(v_repair->>'new_duration'), '');
    v_repair_type := nullif(btrim(v_repair->>'repair_type'), '');

    if v_new_duration is null or v_new_duration !~ '^[1-9][0-9]* days?$' then
      raise exception 'Every repaired duration must be a positive whole number followed by day or days.'
        using errcode = '23514';
    end if;
    if v_repair_type not in ('automatic', 'manual') then
      raise exception 'Invalid duration repair type.' using errcode = '23514';
    end if;

    select medicine.*
      into v_medicine
    from public.nhis_claim_medicines medicine
    join public.nhis_claims claim on claim.id = medicine.claim_id
    where medicine.id = nullif(v_repair->>'medicine_id', '')::uuid
    for update of medicine;

    if v_medicine.id is null then
      raise exception 'A medicine selected for duration repair no longer exists.' using errcode = 'P0002';
    end if;
    select organization_id into v_organization_id
    from public.nhis_claims
    where id = v_medicine.claim_id;
    if v_organization_id is distinct from v_actor.organization_id then
      raise exception 'A medicine selected for duration repair belongs to another organization.' using errcode = '42501';
    end if;
    if nullif(btrim(v_medicine.duration), '') is distinct from v_old_duration then
      raise exception 'A medicine duration changed after review. Rescan the batch before applying repairs.' using errcode = '40001';
    end if;

    update public.nhis_claim_medicines
    set duration = v_new_duration
    where id = v_medicine.id;

    -- Make the parent claim the newest synchronization version so an older
    -- offline copy cannot silently replace the repaired medicine directions.
    update public.nhis_claims
    set updated_at = now()
    where id = v_medicine.claim_id;

    insert into public.nhis_duration_repair_audit (
      organization_id, claim_id, medicine_id, previous_value,
      new_value, repair_type, actor_id
    ) values (
      v_organization_id, v_medicine.claim_id, v_medicine.id, v_old_duration,
      v_new_duration, v_repair_type, auth.uid()
    );

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'claim_id', v_medicine.claim_id,
      'medicine_id', v_medicine.id,
      'previous_value', v_old_duration,
      'new_value', v_new_duration,
      'repair_type', v_repair_type
    ));
  end loop;

  return v_result;
end;
$$;

revoke all on function public.repair_nhis_claim_medicine_durations(jsonb) from public, anon;
grant execute on function public.repair_nhis_claim_medicine_durations(jsonb) to authenticated;

comment on function public.repair_nhis_claim_medicine_durations(jsonb) is
  'Atomically repairs reviewed NHIS medicine durations and records old/new values, actor, type, and timestamp.';

notify pgrst, 'reload schema';
