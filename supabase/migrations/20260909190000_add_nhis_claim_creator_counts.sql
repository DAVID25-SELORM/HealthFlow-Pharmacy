-- Count creation work across all matching claims, not just the UI page.
-- Invoker rights retain existing claim/staff RLS and organization isolation.
create or replace function public.get_nhis_claim_creator_counts(
  p_from_date date, p_to_date date
)
returns table (creator_id uuid, creator_name text, claim_count bigint)
language plpgsql stable security invoker
set search_path = public, pg_catalog
as $$
begin
  if p_from_date is null or p_to_date is null or p_to_date < p_from_date then
    raise exception 'Choose a valid claim creation date range.' using errcode = '22023';
  end if;
  return query
  select c.created_by,
         coalesce(nullif(u.full_name::text, ''),
           case when c.created_by is null then 'Unassigned creator' else 'Unavailable staff member' end),
         count(*)
  from public.nhis_claims c
  left join public.users u on u.id = c.created_by
    and u.organization_id = c.organization_id
  where c.organization_id = public.user_organization_id()
    and c.created_at >= (p_from_date::timestamp at time zone 'Africa/Accra')
    and c.created_at < ((p_to_date + 1)::timestamp at time zone 'Africa/Accra')
  group by c.created_by, u.full_name
  order by count(*) desc, c.created_by nulls last;
end;
$$;
revoke all on function public.get_nhis_claim_creator_counts(date, date) from public, anon;
grant execute on function public.get_nhis_claim_creator_counts(date, date) to authenticated;
notify pgrst, 'reload schema';
