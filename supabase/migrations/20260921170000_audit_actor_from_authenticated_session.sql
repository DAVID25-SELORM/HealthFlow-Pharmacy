-- Accreditation-date audit: attribute changes only to the authenticated session.
--
-- Forward correction of 20260921140000. That version fell back to the row's `updated_by`
-- when there was no authenticated user, but `updated_by` is written by the client (or an
-- offline branch), so trusting it could attribute a change to someone who did not make it.
-- Now the actor is `auth.uid()` only; changes arriving through offline-branch sync or SQL
-- have a null actor and are labelled `system_or_branch_sync`. The email is recorded only for
-- an authenticated actor.
--
-- Deliberately unchanged: the audit still can never make a settings save fail (a failure is
-- logged as a warning). Whether a failed audit write should instead block the save is a
-- separate policy decision (docs/proposals/README-audit-write-failure-policy.md).
--
-- Function-only migration: no data is read, changed or backfilled. Replay-safe.
-- Apply only through the normal, explicitly authorized deployment workflow.

create or replace function public.audit_nhia_accreditation_date_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_actor uuid;
  v_email text;
  v_field text;
  v_previous text;
  v_new text;
begin
  begin
    v_actor := auth.uid();
    begin
      v_email := case when v_actor is not null then auth.email() else null end;
    exception when others then
      v_email := null;
    end;

    foreach v_field in array array['accreditation_date_generated', 'accreditation_expiry_date'] loop
      v_new := to_jsonb(new) ->> v_field;
      v_previous := case when tg_op = 'UPDATE' then to_jsonb(old) ->> v_field else null end;
      if v_new is not distinct from v_previous then
        continue;
      end if;

      insert into public.audit_logs (
        actor_user_id, actor_email, event_type, entity_type, entity_id, action, details, organization_id, created_at
      ) values (
        v_actor,
        v_email,
        'nhia_accreditation_date_changed',
        'nhia_configuration',
        new.id,
        'nhia_config.accreditation_date_changed',
        jsonb_build_object(
          'facility_id', new.organization_id,
          'branch_id', new.branch_id,
          'field', v_field,
          'previous_value', v_previous,
          'new_value', v_new,
          'changed_at', now(),
          'operation', lower(tg_op),
          'source', case when v_actor is null then 'system_or_branch_sync' else 'authenticated_user' end
        ),
        new.organization_id,
        now()
      );
    end loop;
  exception when others then
    -- Auditing must never block a settings save; surface the problem in the database log.
    raise warning 'nhia accreditation date audit failed: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.audit_nhia_accreditation_date_changes() from public, anon, authenticated;
