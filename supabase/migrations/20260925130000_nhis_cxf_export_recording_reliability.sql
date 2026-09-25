-- NHIS CXF export: make the server-side export/audit lifecycle reliable at production scale.
--
-- Why the two RPCs returned HTTP 500 for a 3,093-claim export
-- ---------------------------------------------------------
-- claimit_export_claims() and record_nhis_cxf_export_atomic() both build
-- claimit_snapshot(): to_jsonb(nhis_claims) plus lines. nhis_claims.claimit_attachment_base64 holds the whole
-- prescription PDF as base64 (avg ~320 KB, max ~1.1 MB), so one snapshot averages ~340 KB. For a 500-claim
-- batch claimit_export_claims() hashes that three times per claim, appends each snapshot to a growing jsonb
-- (quadratic copying) and RETURNS every snapshot, ~170 MB per call. Measured on production: 10 claims 0.18 s,
-- 50 claims 0.97 s, 100 claims 3.5 s. The `authenticated` role has statement_timeout = 8s, so a 500-claim call
-- is cancelled (SQLSTATE 57014, surfaced by PostgREST as HTTP 500). record_nhis_cxf_export_atomic() then
-- re-ran that whole computation for all 3,093 claims inside ONE statement, so it can never finish inside 8 s.
--
-- What this migration does (additive; nothing is dropped, no signature or return type changes)
--   1. claimit_export_signing_evidence(): the same evidence (signer, warnings, fingerprints) without returning
--      the snapshot. ~5.5 ms per claim, linear, small response. Fingerprints are byte-identical to
--      claimit_export_claims() because the same claimit_snapshot()/claimit_fingerprint() are used.
--   2. Idempotent recording: a unique index on (claim_id, event_type, artifact_sha256) plus a
--      record_nhis_cxf_export() that skips a claim already recorded for the same artifact. Retrying after a
--      timeout or failure can never create duplicate events or turn a first export into a "re-export".
--   3. record_nhis_cxf_export() stays transactional per call (a failed chunk records nothing); the client now
--      records in chunks of <= 500 claims so each call fits inside the timeout and only failed chunks are retried.
--   Legacy unsigned claims stay non-blocking. claimit_export_claims() itself is left unchanged.
begin;

create unique index if not exists nhis_cxf_events_artifact_once
  on public.nhis_cxf_events (claim_id, event_type, artifact_sha256)
  where artifact_sha256 is not null
    and event_type in ('CLAIM_EXPORT_VALIDATED', 'CXF_EXPORTED', 'CXF_REEXPORTED');

-- Internal: evidence for up to 500 claims. Same authorization as claimit_export_claims() (claimit_actor()
-- raises 42501 for another organization's claim). Locks the rows only when the caller is about to record.
create or replace function public.claimit_export_evidence(
  p_claim_ids uuid[],
  p_reexport_reason text,
  p_lock boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  c public.nhis_claims%rowtype;
  actor public.users%rowtype;
  snap jsonb;
  warnings text[];
  fp text;
  signature public.nhis_claim_signatures%rowtype;
  result jsonb[] := '{}';
  config jsonb;
  count_found integer := 0;
  org uuid;
begin
  if coalesce(cardinality(p_claim_ids), 0) not between 1 and 500 then
    raise exception 'Select between 1 and 500 claims per export batch.' using errcode = '22023';
  end if;
  if cardinality(p_claim_ids) <> (select count(distinct x) from unnest(p_claim_ids) x) then
    raise exception 'Duplicate claim IDs.' using errcode = '22023';
  end if;

  if p_lock then
    -- Authorize every organization first (claimit_actor raises 42501), so a caller can never take row locks
    -- on claims it may not export, then lock in id order so concurrent retries cannot deadlock.
    for org in select distinct organization_id from public.nhis_claims where id = any(p_claim_ids) loop
      perform public.claimit_actor(org);
    end loop;
    perform 1 from public.nhis_claims where id = any(p_claim_ids) order by id for update;
  end if;

  for c in select * from public.nhis_claims where id = any(p_claim_ids) order by id loop
    actor := public.claimit_actor(c.organization_id);
    snap := public.claimit_snapshot(c.id);
    warnings := public.claimit_claim_issues(snap) || public.claimit_context_issues(snap);
    fp := public.claimit_fingerprint(snap);
    select * into signature from public.nhis_claim_signatures where claim_id = c.id and claim_fingerprint = fp;
    -- Claim-IT does not require signers (the accepted June export had none): reported, never enforced.
    if not found then warnings := array_append(warnings, 'LEGACY_UNSIGNED_CLAIM'); end if;
    if c.status in ('submitted', 'accepted', 'approved', 'paid')
       or exists (select 1 from public.nhis_cxf_events
                   where claim_id = c.id and event_type in ('CXF_EXPORTED', 'CXF_REEXPORTED')) then
      if nullif(btrim(p_reexport_reason), '') is null then
        warnings := array_append(warnings, 'REEXPORT_WITHOUT_REASON');
      end if;
    end if;
    select to_jsonb(n) into config from public.nhia_configuration n
      where n.organization_id = c.organization_id and n.is_active
        and (n.branch_id = c.branch_id or n.branch_id is null)
      order by n.branch_id nulls last, n.updated_at desc limit 1;

    result := result || jsonb_build_object(
      'id', c.id,
      'organization_id', c.organization_id,
      'status', c.status,
      'signed_on', signature.signed_on,
      'signed_by_user_id', signature.signed_by_user_id,
      'signed_by_name', signature.signed_by_name,
      'signed_by_role', signature.signed_by_role,
      'claimit_signature_id', signature.id,
      'claimit_warnings', to_jsonb(array(select distinct w from unnest(warnings) w order by 1)),
      'claimit_fingerprint', public.claimit_fingerprint(jsonb_build_object('claim', snap, 'config', config)),
      'claimit_export_actor', jsonb_build_object('id', actor.id, 'name', actor.full_name, 'role', actor.role));
    count_found := count_found + 1;
  end loop;

  if count_found <> cardinality(p_claim_ids) then
    raise exception 'Claim not found or access denied.' using errcode = '42501';
  end if;
  return to_jsonb(result);
end $$;

revoke all on function public.claimit_export_evidence(uuid[], text, boolean) from public, anon, authenticated;

-- Public read-only evidence RPC used by the export (replaces the 170 MB claimit_export_claims() call).
create or replace function public.claimit_export_signing_evidence(
  p_claim_ids uuid[],
  p_reexport_reason text default null
) returns jsonb
language sql
security definer
set search_path = public, pg_catalog
as $$ select public.claimit_export_evidence(p_claim_ids, p_reexport_reason, false) $$;

revoke all on function public.claimit_export_signing_evidence(uuid[], text) from public, anon;
grant execute on function public.claimit_export_signing_evidence(uuid[], text) to authenticated, service_role;

-- Idempotent, transactional recording for one chunk (<= 500 claims). A claim already recorded for this exact
-- artifact is skipped, so a retry after a timeout/500 never duplicates events. Anything else that fails
-- (claim changed since the file was generated, access denied) raises and records nothing for the chunk.
create or replace function public.record_nhis_cxf_export(
  p_claim_ids uuid[],
  p_fingerprints jsonb,
  p_artifact_sha256 text,
  p_reexport_reason text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  evidence jsonb;
  c jsonb;
  kind text;
begin
  if p_artifact_sha256 is null or p_artifact_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Artifact SHA-256 required.' using errcode = '22023';
  end if;
  evidence := public.claimit_export_evidence(p_claim_ids, p_reexport_reason, true);

  for c in select value from jsonb_array_elements(evidence) loop
    -- Already recorded for this artifact (a retry): nothing to do, and no fingerprint comparison, because the
    -- claim may legitimately have been edited after the first successful recording.
    if exists (select 1 from public.nhis_cxf_events
                where claim_id = (c->>'id')::uuid and artifact_sha256 = p_artifact_sha256
                  and event_type in ('CXF_EXPORTED', 'CXF_REEXPORTED')) then
      continue;
    end if;
    if (p_fingerprints->>(c->>'id')) is distinct from (c->>'claimit_fingerprint') then
      raise exception 'Claim changed during export; regenerate the file.' using errcode = '40001';
    end if;
    kind := case
      when c->>'status' in ('submitted', 'accepted', 'approved', 'paid')
        or exists (select 1 from public.nhis_cxf_events
                    where claim_id = (c->>'id')::uuid and event_type in ('CXF_EXPORTED', 'CXF_REEXPORTED'))
      then 'CXF_REEXPORTED' else 'CXF_EXPORTED' end;
    insert into public.nhis_cxf_events(organization_id, claim_id, actor_id, event_type, reason, signature_id,
                                       serializer_version, compatibility_profile, artifact_sha256)
    values
      ((c->>'organization_id')::uuid, (c->>'id')::uuid, auth.uid(), 'CLAIM_EXPORT_VALIDATED', p_reexport_reason,
       (c->>'claimit_signature_id')::uuid, 'claimit-compat-v1', 'claimit-2025053123', p_artifact_sha256),
      ((c->>'organization_id')::uuid, (c->>'id')::uuid, auth.uid(), kind, p_reexport_reason,
       (c->>'claimit_signature_id')::uuid, 'claimit-compat-v1', 'claimit-2025053123', p_artifact_sha256)
    on conflict do nothing;
  end loop;
end $$;

commit;
