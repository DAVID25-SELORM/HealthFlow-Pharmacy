-- MCA (Medicine Counter Assistant) medication edit window — supervisor re-open support.
--
-- Additive only: adds nullable columns that record a 12-hour re-open of the
-- 24-hour MCA edit window, granted by an admin / claims officer with a reason.
-- Does not alter any existing column, claim logic, CC-code, or submission flow.

ALTER TABLE public.nhis_claims
  ADD COLUMN IF NOT EXISTS mca_edit_reopened_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mca_edit_reopen_reason  TEXT,
  ADD COLUMN IF NOT EXISTS mca_edit_reopened_by    UUID,
  ADD COLUMN IF NOT EXISTS mca_edit_reopened_at    TIMESTAMPTZ;

COMMENT ON COLUMN public.nhis_claims.mca_edit_reopened_until IS
  'When set and in the future, re-opens the MCA medication edit window (12h grace granted by admin/claims officer).';
COMMENT ON COLUMN public.nhis_claims.mca_edit_reopen_reason IS
  'Reason captured when an admin/claims officer re-opened the MCA edit window.';
COMMENT ON COLUMN public.nhis_claims.mca_edit_reopened_by IS
  'User who re-opened the MCA edit window.';
