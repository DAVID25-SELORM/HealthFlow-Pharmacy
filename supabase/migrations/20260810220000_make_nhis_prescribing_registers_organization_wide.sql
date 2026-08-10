-- Prescriber and originating-facility registers belong to one HealthFlow
-- organization and are reusable by every authorized branch in that organization.
-- They are never readable or writable by another organization.

drop policy if exists nhis_prescribing_facilities_select_org on public.nhis_prescribing_facilities;
create policy nhis_prescribing_facilities_select_org
  on public.nhis_prescribing_facilities for select to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users viewer
      where viewer.id = auth.uid()
        and viewer.is_active = true
        and viewer.organization_id = nhis_prescribing_facilities.organization_id
    )
  );

drop policy if exists nhis_prescribers_select_org on public.nhis_prescribers;
create policy nhis_prescribers_select_org
  on public.nhis_prescribers for select to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users viewer
      where viewer.id = auth.uid()
        and viewer.is_active = true
        and viewer.organization_id = nhis_prescribers.organization_id
    )
  );

drop policy if exists nhis_prescribing_facilities_write_org on public.nhis_prescribing_facilities;
create policy nhis_prescribing_facilities_write_org
  on public.nhis_prescribing_facilities for all to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users actor
      where actor.id = auth.uid()
        and actor.is_active = true
        and actor.organization_id = nhis_prescribing_facilities.organization_id
        and (
          actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
        )
    )
  )
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users actor
      where actor.id = auth.uid()
        and actor.is_active = true
        and actor.organization_id = nhis_prescribing_facilities.organization_id
        and (
          actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
        )
    )
  );

drop policy if exists nhis_prescribers_write_org on public.nhis_prescribers;
create policy nhis_prescribers_write_org
  on public.nhis_prescribers for all to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users actor
      where actor.id = auth.uid()
        and actor.is_active = true
        and actor.organization_id = nhis_prescribers.organization_id
        and (
          actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
        )
    )
  )
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users actor
      where actor.id = auth.uid()
        and actor.is_active = true
        and actor.organization_id = nhis_prescribers.organization_id
        and (
          actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
        )
    )
  );

comment on table public.nhis_prescribers is
  'Organization-private register of real doctors and authorized clinicians, reusable across the organization branches.';
comment on table public.nhis_prescribing_facilities is
  'Organization-private register of external originating facilities, reusable across the organization branches.';

notify pgrst, 'reload schema';
