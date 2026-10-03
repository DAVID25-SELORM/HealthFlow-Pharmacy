# Manual subscription billing

Implementation is local, not deployed. Apply migration
20261003180000_manual_subscription_billing.sql before deploying the frontend.

Facility admins see the billing panel above the existing dashboard layout. Super
Admin uses the same panel for facility-specific monthly rates, due day (1?28),
and payment approval/rejection. The recipient is 0247654381, David Selorm Gabion.
Hubtel is not displayed. A transfer must be verified against the MoMo account
before approval; entering a transaction ID is not proof of receipt.

Initial billing starts in a current/future calendar month. Existing invoices are
immutable in amount; rate updates generate any outstanding months at the old rate
before changing future invoices. Invoices are materialized on billing access, not
by a background scheduler. There is no retroactive charge before the configured
start month. A single invoice requires its full amount; partial payments and
receipt uploads are not part of this initial version. Payment history records
submission, review actor/time and rejection reason. Audit rows record plan and
payment actions. Rejected transaction IDs remain reserved to prevent their reuse.

Only active primary-role super_admin users may set rates or review payments.
Active facility admins (including assigned admin role) see only their own facility.
Tables deny direct client access, with RLS enabled; RPCs enforce authorization.
No new clinical access gates are introduced. Existing subscription lifecycle rules
remain in force. Approval records last payment and advances the expiry through
settled months without shortening an existing expiry or clearing other arrears.

Deployment smoke check: configure a test facility in staging, submit a unique
transaction reference as its admin, verify pending does not settle it, approve as
Super Admin, and verify paid history and subscription expiry. Do not fabricate a
real production payment to test. No SMS/email notifications or Hubtel are enabled.
