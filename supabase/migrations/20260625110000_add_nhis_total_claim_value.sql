-- Add total generated NHIS claim value to summary stats and page RPC counts.

drop function if exists public.get_nhis_claim_stats();

create or replace function public.get_nhis_claim_stats()
returns table (
  total bigint,
  pending_serving bigint,
  returned_for_review bigint,
  served bigint,
  submitted bigint,
  paid bigint,
  rejected bigint,
  total_claim_value numeric,
  total_paid numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::bigint as total,
    count(*) filter (where status = 'pending_serving')::bigint as pending_serving,
    count(*) filter (where status = 'returned_for_review')::bigint as returned_for_review,
    count(*) filter (where status = 'served')::bigint as served,
    count(*) filter (where status = 'submitted')::bigint as submitted,
    count(*) filter (where status = 'paid')::bigint as paid,
    count(*) filter (where status = 'rejected')::bigint as rejected,
    coalesce(sum(total_amount), 0)::numeric as total_claim_value,
    coalesce(sum(total_amount) filter (where status = 'paid'), 0)::numeric as total_paid
  from public.nhis_claims;
$$;

drop function if exists public.get_nhis_claims_page(
  integer,
  integer,
  text,
  boolean,
  date,
  date,
  text,
  boolean
);

create or replace function public.get_nhis_claims_page(
  p_page integer default 1,
  p_page_size integer default 100,
  p_status text default null,
  p_open_only boolean default false,
  p_from_date date default null,
  p_to_date date default null,
  p_search_term text default null,
  p_include_counts boolean default true
)
returns table (
  claims jsonb,
  total bigint,
  pending_serving bigint,
  returned_for_review bigint,
  served bigint,
  submitted bigint,
  paid bigint,
  rejected bigint,
  total_claim_value numeric,
  total_paid numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      greatest(coalesce(p_page, 1), 1) as page_number,
      least(greatest(coalesce(p_page_size, 100), 1), 500) as page_size,
      nullif(trim(coalesce(p_status, '')), '') as status_filter,
      nullif(trim(coalesce(p_search_term, '')), '') as search_filter
  ),
  filtered as (
    select c.*
    from public.nhis_claims c
    cross join params p
    where
      (p.status_filter is null or p.status_filter = 'all' or c.status = p.status_filter)
      and (
        coalesce(p_open_only, false) = false
        or c.status in ('pending_serving', 'serving_in_progress', 'returned_for_review', 'served', 'submitted')
      )
      and (p_from_date is null or c.service_date_from >= p_from_date)
      and (p_to_date is null or c.service_date_from <= p_to_date)
      and (
        p.search_filter is null
        or c.surname ilike '%' || p.search_filter || '%'
        or c.other_names ilike '%' || p.search_filter || '%'
        or c.member_no ilike '%' || p.search_filter || '%'
        or c.claim_number ilike '%' || p.search_filter || '%'
        or c.hin ilike '%' || p.search_filter || '%'
      )
  ),
  counts as (
    select
      case when p_include_counts then count(*)::bigint end as total,
      case when p_include_counts then count(*) filter (where status = 'pending_serving')::bigint end as pending_serving,
      case when p_include_counts then count(*) filter (where status = 'returned_for_review')::bigint end as returned_for_review,
      case when p_include_counts then count(*) filter (where status = 'served')::bigint end as served,
      case when p_include_counts then count(*) filter (where status = 'submitted')::bigint end as submitted,
      case when p_include_counts then count(*) filter (where status = 'paid')::bigint end as paid,
      case when p_include_counts then count(*) filter (where status = 'rejected')::bigint end as rejected,
      case when p_include_counts then coalesce(sum(total_amount), 0)::numeric end as total_claim_value,
      case when p_include_counts then coalesce(sum(total_amount) filter (where status = 'paid'), 0)::numeric end as total_paid
    from filtered
  ),
  paged as (
    select c.*
    from filtered c
    order by c.created_at desc
    offset (select (page_number - 1) * page_size from params)
    limit (select page_size from params)
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'claim_number', p.claim_number,
          'patient_id', p.patient_id,
          'member_no', p.member_no,
          'card_type', p.card_type,
          'hin', p.hin,
          'surname', p.surname,
          'other_names', p.other_names,
          'folder_no', p.folder_no,
          'gender', p.gender,
          'date_of_birth', p.date_of_birth,
          'service_date_from', p.service_date_from,
          'service_date_to', p.service_date_to,
          'branch_id', p.branch_id,
          'total_amount', p.total_amount,
          'status', p.status,
          'created_at', p.created_at,
          'updated_at', p.updated_at,
          'prescription_file_url', p.prescription_file_url,
          'prescription_file_path', p.prescription_file_path,
          'prescription_file_name', p.prescription_file_name,
          'nhis_claim_services', '[]'::jsonb,
          'nhis_claim_medicines', coalesce((
            select jsonb_agg(jsonb_build_object('id', m.id))
            from public.nhis_claim_medicines m
            where m.claim_id = p.id
          ), '[]'::jsonb),
          '_summaryOnly', true
        )
        order by p.created_at desc
      ) filter (where p.id is not null),
      '[]'::jsonb
    ) as claims,
    counts.total,
    counts.pending_serving,
    counts.returned_for_review,
    counts.served,
    counts.submitted,
    counts.paid,
    counts.rejected,
    counts.total_claim_value,
    counts.total_paid
  from counts
  left join paged p on true
  group by
    counts.total,
    counts.pending_serving,
    counts.returned_for_review,
    counts.served,
    counts.submitted,
    counts.paid,
    counts.rejected,
    counts.total_claim_value,
    counts.total_paid;
$$;
