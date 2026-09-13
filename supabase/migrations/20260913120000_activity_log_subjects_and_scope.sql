-- Read-only projection: never rewrite historical audit payloads or timestamps.
-- Only tier-access may call this RPC; scope and permissions come from its
-- authenticated requester, never the browser. No speculative indexes added.
begin;
create or replace function public.get_activity_log_view(
  p_organization_id uuid,
  p_branch_id uuid default null,
  p_permissions jsonb default '{}'::jsonb,
  p_from_date date default null,
  p_to_date date default null,
  p_actor_user_id uuid default null,
  p_event_type text default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_result jsonb;
begin
  if p_organization_id is null then
    raise exception 'An organization is required.' using errcode = '22023';
  end if;
  if p_from_date > p_to_date then
    raise exception 'Invalid activity-log date range.' using errcode = '22007';
  end if;
  with tenant_logs as materialized (
    -- Legacy rows without a recorded tenant cannot safely be attributed using
    -- an actor's present-day employer. Fail closed instead of guessing.
    select a.*,
      case
        when a.entity_type in ('nhis_claim', 'nhis_claims') then 'claim'
        when a.entity_type in ('patient', 'patients') then 'patient'
        when a.entity_type in ('drug', 'drugs', 'inventory', 'nhis_drugs') then 'medicine'
        when a.entity_type in ('sale', 'sales') then 'sale'
        when a.entity_type in ('user', 'users', 'staff') then 'staff'
        when a.entity_type like '%setting%' then 'setting'
        when a.entity_type like '%payment%' then 'payment'
        when a.entity_type like '%attachment%' then 'attachment'
        when a.entity_type like '%report%' then 'report'
        else 'record'
      end as kind
    from public.audit_logs a
    where a.organization_id = p_organization_id
  ), resolved as (
    select a.*, actor.full_name as actor_name,
      actor.is_active as actor_is_active,
      case when c.id is not null then jsonb_build_object('surname', c.surname, 'other_names', c.other_names, 'claim_number', c.claim_number, 'prescription_reference', c.prescription_reference) end as claim_record,
      case when d.id is not null then jsonb_build_object('name', d.name, 'strength', to_jsonb(d)->>'strength') end as drug_record,
      case when s.id is not null then jsonb_build_object('sale_number', s.sale_number) end as sale_record,
      case when p.id is not null then jsonb_build_object('full_name', p.full_name) end as patient_record,
      case when u.id is not null then jsonb_build_object('full_name', u.full_name) end as staff_record,
      coalesce(c.branch_id::text, d.branch_id::text, s.branch_id::text,
        u.branch_id::text, nullif(a.details->>'branch_id', '')) as record_branch,
      coalesce((p_permissions->>a.kind)::boolean, false) as can_identify
    from tenant_logs a
    left join public.users actor on actor.id = a.actor_user_id and actor.organization_id = p_organization_id
    left join public.nhis_claims c on a.kind = 'claim' and c.id = a.entity_id and c.organization_id = p_organization_id
    left join public.drugs d on a.kind = 'medicine' and a.entity_type <> 'nhis_drugs' and d.id = a.entity_id and d.organization_id = p_organization_id
    left join public.sales s on a.kind = 'sale' and s.id = a.entity_id and s.organization_id = p_organization_id
    left join public.patients p on a.kind = 'patient' and p.id = a.entity_id and p.organization_id = p_organization_id
    left join public.users u on a.kind = 'staff' and u.id = a.entity_id and u.organization_id = p_organization_id
  ), scoped as materialized (
    select * from resolved
    where p_branch_id is null or record_branch = p_branch_id::text
  ), projected as materialized (
    select id, actor_user_id, actor_email, actor_name, actor_is_active,
      event_type, entity_type, action, created_at,
      jsonb_strip_nulls(jsonb_build_object(
        'active_role', details->>'active_role',
        'status', case when can_identify then details->>'status' end,
        'reason', case when can_identify then coalesce(details->>'reason', details->>'rejection_reason') end,
        'previous_status', case when can_identify then coalesce(details->>'previous_status', details->'old_value'->>'status') end,
        'new_status', case when can_identify then coalesce(details->>'new_status', details->'new_value'->>'status') end
      )) as details,
      jsonb_build_object('type', kind, 'restricted', not can_identify,
        'fields', case when not can_identify then '{}'::jsonb else jsonb_strip_nulls(
          case kind
            when 'claim' then jsonb_build_object(
              'Patient', coalesce(nullif(details->>'patient_name', ''), nullif(trim(concat_ws(' ', claim_record->>'surname', claim_record->>'other_names')), '')),
              'Claim', coalesce(nullif(details->>'claim_number', ''), claim_record->>'claim_number'),
              'Prescription', coalesce(nullif(details->>'prescription_reference', ''), claim_record->>'prescription_reference'))
            when 'patient' then jsonb_build_object('Patient', coalesce(nullif(details->>'patient_name', ''), nullif(details->>'full_name', ''), patient_record->>'full_name'))
            when 'medicine' then jsonb_build_object('Medicine', coalesce(nullif(details->>'medicine_name', ''), nullif(details->>'drug_name', ''), nullif(details->>'name', ''), drug_record->>'name'), 'Strength', coalesce(nullif(details->>'strength', ''), drug_record->>'strength'))
            when 'sale' then jsonb_build_object('Sale', coalesce(nullif(details->>'sale_number', ''), nullif(details->>'receipt_number', ''), sale_record->>'sale_number'))
            when 'staff' then jsonb_build_object('Staff member', coalesce(nullif(details->>'full_name', ''), staff_record->>'full_name'))
            when 'setting' then jsonb_build_object('Setting', coalesce(nullif(details->>'setting_name', ''), nullif(details->>'setting', '')))
            when 'payment' then jsonb_build_object('Payment', nullif(details->>'payment_reference', ''))
            when 'attachment' then jsonb_build_object('Attachment', nullif(details->>'file_name', ''))
            when 'report' then jsonb_build_object('Report', nullif(details->>'report_name', ''))
            else '{}'::jsonb end) end,
        'source', case when not can_identify then 'restricted'
          when details ?| array['patient_name','claim_number','prescription_reference','medicine_name','drug_name','name','sale_number','receipt_number','full_name','setting_name','setting','payment_reference','file_name','report_name'] then case when coalesce(claim_record, drug_record, sale_record, patient_record, staff_record) is null then 'snapshot' else 'snapshot_or_current' end
          when coalesce(claim_record, drug_record, sale_record, patient_record, staff_record) is not null then 'current'
          else 'unavailable' end
      ) as subject
    from scoped
  ), filtered as materialized (
    select * from projected
    where (p_actor_user_id is null or actor_user_id = p_actor_user_id)
      and (nullif(p_event_type, '') is null or event_type = p_event_type)
      and (p_from_date is null or created_at >= p_from_date::timestamp at time zone 'Africa/Accra')
      and (p_to_date is null or created_at < (p_to_date + 1)::timestamp at time zone 'Africa/Accra')
      -- Search only the authorized projection. Hidden metadata must not leak
      -- through matching counts, even if it is absent from the returned page.
      and (nullif(btrim(p_search), '') is null or strpos(lower(concat_ws(' ',
        actor_name, actor_email, replace(event_type, '_', ' '), event_type,
        entity_type, action, subject->'fields', details)), lower(btrim(p_search))) > 0)
  ), page_rows as (
    select * from filtered order by created_at desc, id desc
    offset (greatest(coalesce(p_page, 1), 1) - 1)::bigint * least(greatest(coalesce(p_page_size, 100), 1), 500)
    limit least(greatest(coalesce(p_page_size, 100), 1), 500)
  )
  select jsonb_build_object(
    'logs', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc) from page_rows r), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'actors', coalesce((select jsonb_agg(to_jsonb(officer) order by officer.full_name, officer.id) from (
      select actor_user_id as id, coalesce(max(actor_name), max(actor_email), 'Historical staff member') as full_name, max(actor_email) as email, bool_or(actor_is_active) as is_active
      from scoped where actor_user_id is not null group by actor_user_id
    ) officer), '[]'::jsonb),
    'eventTypes', coalesce((select jsonb_agg(e.event_type order by e.event_type) from (select distinct event_type from scoped) e), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_activity_log_view(uuid, uuid, jsonb, date, date, uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_activity_log_view(uuid, uuid, jsonb, date, date, uuid, text, text, integer, integer) to service_role;
notify pgrst, 'reload schema';
commit;
