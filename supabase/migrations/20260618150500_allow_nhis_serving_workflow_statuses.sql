-- Align the cloud NHIS claim status constraint with the Claims Officer -> MCA
-- serving workflow used by the application.

alter table if exists public.nhis_claims
  drop constraint if exists nhis_claims_status_check;

alter table if exists public.nhis_claims
  add constraint nhis_claims_status_check
  check (
    status in (
      'draft',
      'pending',
      'pending_serving',
      'serving_in_progress',
      'returned_for_review',
      'served',
      'partially_served',
      'fully_served',
      'submitted',
      'approved',
      'accepted',
      'rejected',
      'paid',
      'failed'
    )
  );
