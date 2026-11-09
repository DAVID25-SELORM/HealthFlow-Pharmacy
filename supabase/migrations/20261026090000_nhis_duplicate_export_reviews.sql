-- Per-group "reviewed - not a duplicate" decisions for NHIS claim export.
--
-- Today any group of claims with the same facility, member, service date and
-- CCC blocks the whole export until all but one claim is recycled. A facility
-- can legitimately have several prescriptions on one visit, so an admin or
-- claims officer may now record, per group, that the group was reviewed and
-- must export in full. The decision names the exact claims reviewed: if a new
-- claim later joins the group, the stored claim set no longer matches and the
-- group blocks again. Nothing here changes any claim, stock or CCC row.
begin;

create table if not exists public.nhis_duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_key text not null check (length(group_key) between 1 and 400),
  claim_ids uuid[] not null check (cardinality(claim_ids) between 2 and 50),
  service_date date not null,
  ccc_no text not null,
  reason text not null check (length(btrim(reason)) between 10 and 500),
  reviewed_by uuid not null references public.users(id),
  reviewed_at timestamptz not null default now(),
  revoked_by uuid references public.users(id),
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or length(btrim(revoke_reason)) between 5 and 500),
  check ((revoked_at is null) = (revoked_by is null))
);

create unique index if not exists nhis_duplicate_reviews_one_active
  on public.nhis_duplicate_reviews (organization_id, group_key, claim_ids)
  where revoked_at is null;
create index if not exists nhis_duplicate_reviews_org_active
  on public.nhis_duplicate_reviews (organization_id) where revoked_at is null;

alter table public.nhis_duplicate_reviews enable row level security;
revoke all on public.nhis_duplicate_reviews from public, anon, authenticated;
grant select on public.nhis_duplicate_reviews to authenticated;
grant all on public.nhis_duplicate_reviews to service_role;

-- Facility members can read their own decisions. All writes go through the
-- functions below, which check the caller's role and facility.
drop policy if exists nhis_duplicate_reviews_select_org on public.nhis_duplicate_reviews;
create policy nhis_duplicate_reviews_select_org on public.nhis_duplicate_reviews
  for select to authenticated
  using (organization_id = public.user_organization_id());

create or replace function public.review_nhis_duplicate_group(
  p_group_key text, p_claim_ids uuid[], p_reason text
) returns uuid
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  v_org uuid;
  v_ids uuid[];
  v_found integer;
  v_dates integer;
  v_cccs integer;
  v_date date;
  v_ccc text;
  v_review uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select u.organization_id into v_org
  from public.users u
  where u.id = auth.uid()
    and u.is_active is true
    and (u.role in ('admin', 'claims_officer')
      or coalesce(u.assigned_roles, '{}'::text[]) && array['admin', 'claims_officer']::text[]);
  if v_org is null then
    raise exception 'Only an administrator or claims officer can review duplicate claims.';
  end if;
  if nullif(btrim(coalesce(p_group_key, '')), '') is null or length(p_group_key) > 400 then
    raise exception 'A duplicate group is required.';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'Enter a reason of 10 to 500 characters.';
  end if;
  -- Sorted, distinct: the stored set is compared exactly at export time.
  select array_agg(distinct x order by x) into v_ids from unnest(coalesce(p_claim_ids, '{}'::uuid[])) as x;
  if v_ids is null or cardinality(v_ids) < 2 or cardinality(v_ids) > 50 then
    raise exception 'A duplicate group needs between 2 and 50 claims.';
  end if;
  if p_group_key not like v_org::text || '|%' then
    raise exception 'This duplicate group does not belong to your facility.';
  end if;

  select count(*), count(distinct c.service_date_from),
         count(distinct regexp_replace(coalesce(c.ccc_no, ''), '\D', '', 'g')),
         min(c.service_date_from), min(regexp_replace(coalesce(c.ccc_no, ''), '\D', '', 'g'))
    into v_found, v_dates, v_cccs, v_date, v_ccc
  from public.nhis_claims c
  where c.id = any(v_ids)
    and c.organization_id = v_org
    and lower(btrim(coalesce(c.status, ''))) in ('served', 'submitted');
  if v_found <> cardinality(v_ids) then
    raise exception 'Every claim in the group must be an active claim of your facility.';
  end if;
  if v_dates <> 1 or v_cccs <> 1 or v_date is null or nullif(btrim(v_ccc), '') is null then
    raise exception 'The claims in a duplicate group must share one service date and CCC.';
  end if;

  insert into public.nhis_duplicate_reviews
    (organization_id, group_key, claim_ids, service_date, ccc_no, reason, reviewed_by)
  values (v_org, p_group_key, v_ids, v_date, v_ccc, v_reason, auth.uid())
  on conflict (organization_id, group_key, claim_ids) where revoked_at is null
  do update set reason = excluded.reason, reviewed_by = excluded.reviewed_by, reviewed_at = now()
  returning id into v_review;

  begin
    perform public.log_audit_event('nhis_duplicate_review', 'nhis_duplicate_reviews', v_review,
      'reviewed_not_duplicate',
      jsonb_build_object('group_key', p_group_key, 'claim_ids', v_ids, 'reason', v_reason), v_org);
  exception when others then
    null; -- the review row itself records who, when and why
  end;
  return v_review;
end;
$$;

create or replace function public.revoke_nhis_duplicate_review(
  p_review_id uuid, p_reason text
) returns void
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  v_org uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_changed integer;
begin
  select u.organization_id into v_org
  from public.users u
  where u.id = auth.uid()
    and u.is_active is true
    and (u.role in ('admin', 'claims_officer')
      or coalesce(u.assigned_roles, '{}'::text[]) && array['admin', 'claims_officer']::text[]);
  if v_org is null then
    raise exception 'Only an administrator or claims officer can withdraw a duplicate review.';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then
    raise exception 'Enter a reason of 5 to 500 characters.';
  end if;
  update public.nhis_duplicate_reviews
     set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = v_reason
   where id = p_review_id and organization_id = v_org and revoked_at is null;
  get diagnostics v_changed = row_count;
  if v_changed = 0 then
    raise exception 'No active duplicate review was found for your facility.';
  end if;
  begin
    perform public.log_audit_event('nhis_duplicate_review', 'nhis_duplicate_reviews', p_review_id,
      'review_withdrawn', jsonb_build_object('reason', v_reason), v_org);
  exception when others then
    null;
  end;
end;
$$;

revoke all on function public.review_nhis_duplicate_group(text, uuid[], text) from public, anon;
revoke all on function public.revoke_nhis_duplicate_review(uuid, text) from public, anon;
grant execute on function public.review_nhis_duplicate_group(text, uuid[], text) to authenticated;
grant execute on function public.revoke_nhis_duplicate_review(uuid, text) to authenticated;

notify pgrst, 'reload schema';
commit;
