-- Backfill NHIS medicine serving actor trace for historical rows.
-- This only fills missing audit/display metadata from existing claim actors.
-- It does not alter CCC, pricing, tariff, export, submission, duplicate logic,
-- quantities, totals, or claim statuses.

update public.nhis_claim_medicines medicine
set
  served_by_mca = coalesce(
    claim.direct_served_by,
    claim.prescription_updated_by,
    claim.prescription_entered_by
  ),
  served_at = coalesce(
    medicine.served_at,
    claim.direct_served_at,
    claim.prescription_updated_at,
    claim.prescription_entered_at,
    medicine.entered_at,
    claim.updated_at
  )
from public.nhis_claims claim
where medicine.claim_id = claim.id
  and medicine.served_by_mca is null
  and coalesce(medicine.served_qty, medicine.dispensed_qty, 0) > 0
  and coalesce(
    claim.direct_served_by,
    claim.prescription_updated_by,
    claim.prescription_entered_by
  ) is not null;

