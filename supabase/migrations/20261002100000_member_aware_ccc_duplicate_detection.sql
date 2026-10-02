-- Redesign the facility CCC duplicate guard to be member-aware.
--
-- Problem: guard_facility_ccc_duplicate() (added 2026-09-30, production-only — not previously in this repo's
-- migration history) blocked ANY two claims in the same facility that share a normalized CCC within a 7-day
-- window, with no regard for which member the claim was for. The CCC/CC code is NHIA-issued per encounter, not a
-- patient identifier HealthFlow controls or NHIA guarantees is globally unique (a 5-digit non-biometric code has
-- only 100,000 possible values; OTAC-issued biometric codes are a different, 13-digit format — see
-- docs/nhis-ccc-duplicate-detection.md). Two different members legitimately sharing a CCC value at the same
-- facility in the same week is expected, not fraud, and was being hard-blocked.
--
-- Fix: only hard-block the case that is actually suspicious — the SAME member, SAME CCC, SAME facility, SAME
-- service date, against another claim that is not rejected/failed. A different member with the same CCC is never
-- blocked here (the application layer may still show an informational notice; see nhisCccDuplicate.js). This
-- mirrors, at the database level, the member+date+amount duplicate check the application already performs in
-- assertNoDuplicateNhisClaimInStore() — this trigger exists as its concurrency/bypass backstop, not a parallel
-- source of truth, so the two must not diverge in what they consider "the same claim".
--
-- Additive: no table or trigger is dropped. nhis_ccc_reservations stops being written to (it is no longer needed:
-- the new check is a plain, member-scoped EXISTS plus a real unique index — see below), but the table and its
-- existing release trigger are left in place rather than torn out in the same change that fixes production.
begin;

-- The real concurrency guarantee: two concurrent inserts for the same member+CCC+facility+date cannot both commit.
-- (A genuine race on this exact combination still surfaces as a raw duplicate-key error; the trigger below is what
-- gives the normal, non-racing path its specific, actionable message.)
create unique index if not exists nhis_claims_member_ccc_duplicate_idx on public.nhis_claims (
  organization_id,
  (coalesce(nullif(regexp_replace(member_no, '[^0-9]', '', 'g'), ''),
            nullif(regexp_replace(hin, '[^0-9]', '', 'g'), ''))),
  (regexp_replace(coalesce(ccc_no, ''), '[^0-9]', '', 'g')),
  service_date_from
) where status not in ('rejected', 'failed')
  and coalesce(nullif(regexp_replace(member_no, '[^0-9]', '', 'g'), ''),
               nullif(regexp_replace(hin, '[^0-9]', '', 'g'), '')) is not null
  and regexp_replace(coalesce(ccc_no, ''), '[^0-9]', '', 'g') <> ''
  and service_date_from is not null;

create or replace function public.guard_facility_ccc_duplicate()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_code text := regexp_replace(coalesce(new.ccc_no, ''), '[^0-9]', '', 'g');
  v_member text := coalesce(nullif(regexp_replace(new.member_no, '[^0-9]', '', 'g'), ''),
                             nullif(regexp_replace(new.hin, '[^0-9]', '', 'g'), ''));
  v_old_member text;
  v_conflict record;
begin
  -- Unchanged from this row's own perspective: identical member, CCC, facility and date as before this write. Also
  -- covers an UPDATE that only touches unrelated columns.
  if tg_op = 'UPDATE' and new.organization_id is not distinct from old.organization_id then
    v_old_member := coalesce(nullif(regexp_replace(old.member_no, '[^0-9]', '', 'g'), ''),
                               nullif(regexp_replace(old.hin, '[^0-9]', '', 'g'), ''));
    if v_member is not distinct from v_old_member
       and v_code = regexp_replace(coalesce(old.ccc_no, ''), '[^0-9]', '', 'g')
       and new.service_date_from is not distinct from old.service_date_from then
      return new;
    end if;
  end if;

  -- A CCC/member/date cannot be judged a duplicate without all three; an empty CCC, unidentified member, or
  -- missing service date is never treated as "the same claim" by this guard.
  if v_code = '' or v_member is null or new.organization_id is null or new.service_date_from is null then
    return new;
  end if;

  select c.id, c.claim_number into v_conflict
  from public.nhis_claims c
  where c.organization_id = new.organization_id
    and c.id <> new.id
    and c.status not in ('rejected', 'failed')
    and c.service_date_from = new.service_date_from
    and regexp_replace(coalesce(c.ccc_no, ''), '[^0-9]', '', 'g') = v_code
    and coalesce(nullif(regexp_replace(c.member_no, '[^0-9]', '', 'g'), ''),
                 nullif(regexp_replace(c.hin, '[^0-9]', '', 'g'), '')) = v_member
  limit 1;

  if found then
    raise exception
      'Possible duplicate claim: this patient already has a claim (%) using this CCC/CC code for the same service date. Review the existing claim before continuing.',
      coalesce(v_conflict.claim_number, v_conflict.id::text)
      using errcode = '23505';
  end if;

  return new;
end $$;

revoke all on function public.guard_facility_ccc_duplicate() from public, anon, authenticated;

commit;
