alter table public.users
  add column if not exists assigned_roles text[] not null default '{}',
  add column if not exists can_delete_nhis_claims boolean not null default false;

update public.users
set assigned_roles = array[role]
where coalesce(cardinality(assigned_roles), 0) = 0
  and role is not null;

update public.users
set can_delete_nhis_claims = true
where role in ('admin', 'super_admin')
  and can_delete_nhis_claims = false;

drop policy if exists nhis_claims_delete on public.nhis_claims;
create policy nhis_claims_delete on public.nhis_claims
  for delete to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1
      from public.users
      where id = auth.uid()
        and (
          role in ('admin', 'super_admin')
          or assigned_roles && array['admin', 'super_admin']::text[]
          or can_delete_nhis_claims
        )
    )
  );

drop policy if exists nhis_claims_insert on public.nhis_claims;
create policy nhis_claims_insert on public.nhis_claims
  for insert to authenticated
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1
      from public.users
      where id = auth.uid()
        and (
          role in ('admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer')
          or assigned_roles && array['admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer']::text[]
          or can_manage_claims
        )
    )
  );

drop policy if exists nhis_claims_update on public.nhis_claims;
create policy nhis_claims_update on public.nhis_claims
  for update to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1
      from public.users
      where id = auth.uid()
        and (
          role in ('admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer')
          or assigned_roles && array['admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer']::text[]
          or can_manage_claims
        )
    )
  )
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1
      from public.users
      where id = auth.uid()
        and (
          role in ('admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer')
          or assigned_roles && array['admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer']::text[]
          or can_manage_claims
        )
    )
  );

create or replace function public.serve_nhis_claim_medicines(
  p_claim_id uuid,
  p_medicines jsonb,
  p_total_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.nhis_claims%rowtype;
  v_medicine jsonb;
begin
  if not exists (
    select 1
    from public.users
    where id = auth.uid()
      and is_active = true
      and (
        role in ('admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer')
        or assigned_roles && array['admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer']::text[]
        or can_manage_claims
      )
  ) then
    raise exception 'You do not have permission to serve NHIS medicines.';
  end if;

  select *
  into v_claim
  from public.nhis_claims
  where id = p_claim_id
    and organization_id = public.user_organization_id()
  for update;

  if not found then
    raise exception 'NHIS claim not found.';
  end if;

  delete from public.nhis_claim_medicines
  where claim_id = p_claim_id;

  for v_medicine in
    select value from jsonb_array_elements(coalesce(p_medicines, '[]'::jsonb))
  loop
    insert into public.nhis_claim_medicines (
      claim_id,
      nhis_drug_id,
      drug_code,
      description,
      unit,
      unit_price,
      dispensed_qty,
      dispensary_date,
      dose,
      frequency,
      duration,
      total_amount,
      medicine_access_level,
      required_pharmacy_level
    )
    values (
      p_claim_id,
      nullif(v_medicine->>'nhis_drug_id', '')::uuid,
      nullif(v_medicine->>'drug_code', ''),
      coalesce(nullif(v_medicine->>'description', ''), 'Medicine'),
      coalesce(nullif(v_medicine->>'unit', ''), 'unit'),
      coalesce((v_medicine->>'unit_price')::numeric, 0),
      coalesce((v_medicine->>'dispensed_qty')::numeric, 0),
      nullif(v_medicine->>'dispensary_date', '')::date,
      nullif(v_medicine->>'dose', ''),
      nullif(v_medicine->>'frequency', ''),
      nullif(v_medicine->>'duration', ''),
      coalesce((v_medicine->>'total_amount')::numeric, 0),
      nullif(v_medicine->>'medicine_access_level', ''),
      nullif(v_medicine->>'required_pharmacy_level', '')
    );
  end loop;

  update public.nhis_claims
  set total_amount = coalesce(p_total_amount, total_amount),
      updated_at = now()
  where id = p_claim_id
  returning * into v_claim;

  return to_jsonb(v_claim);
end;
$$;

revoke all on function public.serve_nhis_claim_medicines(uuid, jsonb, numeric) from public;
grant execute on function public.serve_nhis_claim_medicines(uuid, jsonb, numeric) to authenticated;
