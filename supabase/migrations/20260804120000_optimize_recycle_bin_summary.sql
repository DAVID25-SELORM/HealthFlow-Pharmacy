-- Keep Recycle Bin list reads lightweight. Full snapshots remain untouched and
-- continue to be consumed only by the existing restore/delete operations.

create or replace function public.get_deleted_records_summary()
returns table (
  id uuid,
  entity_type text,
  display_name text,
  deleted_at timestamptz,
  snapshot jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    deleted.id,
    deleted.entity_type,
    deleted.display_name,
    deleted.deleted_at,
    case
      when deleted.entity_type = 'nhis_claim' then
        jsonb_build_object(
          'record',
          jsonb_strip_nulls(jsonb_build_object(
            'claim_number', deleted.snapshot->'record'->'claim_number',
            'surname', deleted.snapshot->'record'->'surname',
            'other_names', deleted.snapshot->'record'->'other_names',
            'patient_name', deleted.snapshot->'record'->'patient_name',
            'member_no', deleted.snapshot->'record'->'member_no',
            'hin', deleted.snapshot->'record'->'hin',
            'folder_no', deleted.snapshot->'record'->'folder_no'
          ))
        )
      else '{}'::jsonb
    end as snapshot
  from public.deleted_records deleted
  where exists (
    select 1
    from public.users viewer
    where viewer.id = auth.uid()
      and viewer.organization_id = deleted.organization_id
      and viewer.is_active is distinct from false
      and (
        viewer.role in ('admin', 'super_admin')
        or coalesce(viewer.assigned_roles, '{}'::text[])
          && array['admin', 'super_admin']::text[]
      )
  )
  order by deleted.deleted_at desc;
$$;

revoke all on function public.get_deleted_records_summary() from public;
grant execute on function public.get_deleted_records_summary() to authenticated;

comment on function public.get_deleted_records_summary() is
  'Returns lightweight organization-scoped Recycle Bin list metadata without transferring full deletion snapshots.';
