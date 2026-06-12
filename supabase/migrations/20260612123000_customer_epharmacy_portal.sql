begin;

create table if not exists public.epharmacy_customer_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text not null,
  phone text not null,
  date_of_birth date,
  gender text,
  identity_type text,
  identity_number text,
  address text,
  city text,
  region text,
  digital_address text,
  emergency_contact_name text,
  emergency_contact_phone text,
  allergies text,
  current_medications text,
  terms_accepted_at timestamptz,
  privacy_consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint epharmacy_customer_gender_check
    check (gender is null or gender in ('female', 'male', 'other', 'prefer_not_to_say'))
);

alter table public.epharmacy_orders
  add column if not exists customer_user_id uuid references auth.users(id) on delete set null,
  add column if not exists ordering_for text,
  add column if not exists patient_name text,
  add column if not exists patient_date_of_birth date,
  add column if not exists patient_relationship text,
  add column if not exists delivery_city text,
  add column if not exists delivery_region text,
  add column if not exists delivery_digital_address text,
  add column if not exists clinical_notes text,
  add column if not exists prescription_file_type text,
  add column if not exists prescription_file_size integer;

create index if not exists idx_epharmacy_orders_customer
  on public.epharmacy_orders(customer_user_id, created_at desc);

alter table public.epharmacy_customer_profiles enable row level security;

drop policy if exists epharmacy_customer_profiles_select_own on public.epharmacy_customer_profiles;
create policy epharmacy_customer_profiles_select_own
on public.epharmacy_customer_profiles
for select to authenticated
using (user_id = auth.uid());

drop policy if exists epharmacy_customer_orders_select_own on public.epharmacy_orders;
create policy epharmacy_customer_orders_select_own
on public.epharmacy_orders
for select to authenticated
using (channel = 'customer' and customer_user_id = auth.uid());

drop policy if exists epharmacy_customer_order_items_select_own on public.epharmacy_order_items;
create policy epharmacy_customer_order_items_select_own
on public.epharmacy_order_items
for select to authenticated
using (
  exists (
    select 1
    from public.epharmacy_orders o
    where o.id = order_id
      and o.channel = 'customer'
      and o.customer_user_id = auth.uid()
  )
);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'epharmacy-prescriptions',
  'epharmacy-prescriptions',
  false,
  8388608,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists epharmacy_prescriptions_customer_select on storage.objects;
create policy epharmacy_prescriptions_customer_select
on storage.objects
for select to authenticated
using (
  bucket_id = 'epharmacy-prescriptions'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists epharmacy_prescriptions_customer_insert on storage.objects;
create policy epharmacy_prescriptions_customer_insert
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'epharmacy-prescriptions'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists epharmacy_prescriptions_customer_delete on storage.objects;
create policy epharmacy_prescriptions_customer_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'epharmacy-prescriptions'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create or replace function public.complete_customer_epharmacy_order(
  p_order_id uuid,
  p_actor_user_id uuid,
  p_actor_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.epharmacy_orders%rowtype;
  v_item public.epharmacy_order_items%rowtype;
  v_seller_drug public.drugs%rowtype;
  v_previous numeric(10, 2);
  v_new numeric(10, 2);
  v_completed_count integer := 0;
begin
  if p_actor_user_id is null or p_actor_organization_id is null then
    return jsonb_build_object('error', 'A signed-in facility user is required.');
  end if;

  select *
  into v_order
  from public.epharmacy_orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('error', 'Customer e-pharmacy order not found.');
  end if;

  if v_order.channel <> 'customer' then
    return jsonb_build_object('error', 'Only customer orders can use customer completion.');
  end if;

  if v_order.seller_organization_id <> p_actor_organization_id then
    return jsonb_build_object('error', 'Only the seller facility can complete this order.');
  end if;

  if v_order.status not in ('packed', 'out_for_delivery') then
    return jsonb_build_object('error', 'Only packed or dispatched orders can be marked delivered.');
  end if;

  for v_item in
    select *
    from public.epharmacy_order_items
    where order_id = v_order.id
    order by created_at
  loop
    select *
    into v_seller_drug
    from public.drugs
    where id = v_item.drug_id
      and organization_id = v_order.seller_organization_id
      and status = 'active'
    for update;

    if not found then
      return jsonb_build_object('error', format('Seller stock no longer exists for %s.', v_item.drug_name));
    end if;

    v_previous := coalesce(v_seller_drug.quantity, 0);
    if v_previous < v_item.quantity then
      return jsonb_build_object('error', format('Insufficient seller stock for %s.', v_item.drug_name));
    end if;

    v_new := v_previous - v_item.quantity;

    update public.drugs
    set quantity = v_new, updated_at = now()
    where id = v_seller_drug.id;

    insert into public.stock_movements (
      drug_id,
      movement_type,
      quantity,
      previous_quantity,
      new_quantity,
      reference_id,
      notes,
      created_by,
      organization_id,
      branch_id,
      created_at
    )
    values (
      v_seller_drug.id,
      'sale',
      -v_item.quantity,
      v_previous,
      v_new,
      v_order.id,
      concat('Customer e-pharmacy order ', v_order.order_number, ' delivered'),
      p_actor_user_id,
      v_order.seller_organization_id,
      v_order.seller_branch_id,
      now()
    );

    v_completed_count := v_completed_count + 1;
  end loop;

  update public.epharmacy_orders
  set status = 'delivered', delivered_at = now(), updated_at = now()
  where id = v_order.id;

  return jsonb_build_object(
    'success', true,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'items_completed', v_completed_count
  );
end;
$$;

revoke all on function public.complete_customer_epharmacy_order(uuid, uuid, uuid) from public;
grant execute on function public.complete_customer_epharmacy_order(uuid, uuid, uuid) to service_role;

commit;
